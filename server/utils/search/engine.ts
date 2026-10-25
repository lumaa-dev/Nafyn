// The search pipeline: normalize -> recall -> prescore -> verify (hard filters) -> cover check -> rank.
//
//   recall      several searches from different angles (phrase, loose terms, alias/artist, UPC/ISRC); their
//               candidates are merged, and one that surfaced from several searches gains a little score
//   prescore    title containment, artist similarity (with aliases and sort names), the "different album"
//               guard and the relevance gate - all offline, so the network-bound steps only see plausible hits
//   verify      MusicBrainz search payloads do not tell whether a release-group has an Official digital
//               release, so that is checked with one batched release search (see `verifyAlbums`)
//   rank        lexicographic, FRONT COVER FIRST (see `compareResults`)
//
// Albums are searched at release-group level, tracks at recording level. Everything MusicBrainz goes through
// the repository; the engine has no HTTP of its own.

import type { MusicBrainzRepository } from "../musicbrainzRepository";
import { luceneFuzzyTerms, luceneQuote, luceneTerms } from "../musicbrainzRepository";
import { barcodeForms, parseIsrc, parseUpc, sameBarcode } from "./codes";
import type { SearchConfig } from "./config";
import type { CoverArtChecker } from "./coverArt";
import { detectIntent, hasDeluxeKeyword, hasRemasterKeyword, releaseQualifies, sortableDate, workPasses, type QueryIntent } from "./filters";
import { normalizeText, type NormalizedText } from "./normalize";
import { latinize, needsLatinForm, phoneticKey, romajiToKanaVariants } from "./script";
import { compareNormalized, exactness, levenshteinRatio, nameSimilarity, titleScore, type Comparison } from "./similarity";
import type {
    ArtistSearch, MatchFlag, RawArtistCredit, RawRecording, RawRelease, RawReleaseGroup, RecordingSearch,
    ReleaseGroupSearch, ReleaseSearch, SearchResult
} from "./types";

export interface SearchInput {
    /** Free text, as typed in the search bar. Ignored for the part `title`/`artist` already give. */
    q?: string,
    title?: string,
    artist?: string,
    upc?: string,
    isrc?: string
}

export interface SearchDeps {
    repo: Pick<MusicBrainzRepository, "request">,
    cover: Pick<CoverArtChecker, "hasFront">,
    config: SearchConfig,
    log?: (message: string) => void
}

export interface SearchPage {
    results: SearchResult[],
    /** Results that passed every filter before `limit`/`offset` were applied. */
    total: number
}

// ---------------------------------------------------------------- interpretations

interface Interpretation {
    title: NormalizedText | null,
    artist: NormalizedText | null,
    /** Multiplier on the relevance (an "artist only" reading of free text is a weaker guess). */
    factor: number,
    flags: MatchFlag[],
    /**
     * A reading of the same words in another script (romaji -> kana). Never searched in the first wave, only by
     * its own angle and in scoring, so an ordinary Latin search costs no extra request.
     */
    variant?: boolean
}

// breaks the tie between editions of one work in favour of the one the query named; far below any real score gap
const EDITION_NUDGE = 0.01;

const DASH_SPLIT = /\s[-–—]\s/;

function emptyToNull(text: NormalizedText | null): NormalizedText | null {
    return text && (text.distinctive.length > 0 || text.cjk.length > 0) ? text : null;
}

function buildInterpretations(input: SearchInput, config: SearchConfig): Interpretation[] {
    const base = baseInterpretations(input, config);
    const variants: Interpretation[] = [];
    for (const interpretation of base) {
        const title = interpretation.title;
        // romaji typed for a title that MusicBrainz holds in kana ("Yume Utsutsu" -> ゆめうつつ)
        if (!title || title.cjk.length > 0 || needsLatinForm(title.original)) continue;
        for (const kana of romajiToKanaVariants(title.cleaned).slice(0, 2)) {
            if (Array.from(kana).length < 2) continue;
            const normalized = emptyToNull(normalizeText(kana, config));
            if (normalized) variants.push({ ...interpretation, title: normalized, flags: [...interpretation.flags, "transliterated"], variant: true });
        }
    }
    return [...base, ...variants];
}

function baseInterpretations(input: SearchInput, config: SearchConfig): Interpretation[] {
    const norm = (value: string | undefined) => (value?.trim() ? emptyToNull(normalizeText(value, config)) : null);
    const title = norm(input.title);
    const artist = norm(input.artist);

    if (title || artist) return [{ title, artist, factor: 1, flags: [] }];

    const q = input.q?.trim();
    if (!q) return [];

    // no explicit artist: "Artist - Title" is tried in both orders, and the better-scoring reading wins per result
    const dash = DASH_SPLIT.exec(q);
    if (dash) {
        const left = norm(q.slice(0, dash.index));
        const right = norm(q.slice(dash.index + dash[0].length));
        if (left && right) {
            return [
                { title: right, artist: left, factor: 1, flags: [] },
                { title: left, artist: right, factor: 1, flags: ["swapped_order"] }
            ];
        }
    }

    const whole = norm(q);
    if (!whole) return [];
    return [
        { title: whole, artist: null, factor: 1, flags: [] },
        { title: null, artist: whole, factor: config.artistOnlyFactor, flags: ["artist_only"] }
    ];
}

/** The most an artist-catalogue recall asks for: MusicBrainz' own maximum page. */
const CATALOGUE_LIMIT = 100;

// ---------------------------------------------------------------- candidates

interface Candidate {
    kind: "album" | "track",
    id: string,
    title: string,
    /** MusicBrainz' recording disambiguation ("live, 1975: Earls Court", "2007 remix"). */
    disambiguation: string,
    credits: RawArtistCredit[],
    primaryType: string | null,
    secondaryTypes: string[],
    firstReleaseDate: string | null,
    length: number | null,
    releases: RawRelease[],
    /**
     * The same work under other names: the title a Latin-script release gives a recording ("Hatachi No Koi" for
     * 二十歳の恋), or the titles of an album's releases. Compared like the title itself.
     */
    altTitles: string[],
    /** Set by a UPC/ISRC lookup. */
    code: { kind: "upc" | "isrc", value: string } | null,
    sources: Set<string>,
    // filled in by verification
    qualifying: RawRelease[],
    albumId: string | null
}

interface Evaluated {
    candidate: Candidate,
    title: number,
    artist: number,
    exactness: number,
    relevance: number,
    flags: MatchFlag[]
}

type Scored = Evaluated & { hasFrontCover: boolean };

// MusicBrainz keeps "this is the live take" out of a recording's title and in its disambiguation. For matching
// it is part of the title - otherwise every live version of a song ties with the studio original - but only the
// leading word ("live", "demo", "acoustic"...) and never the venue and date that follow it.
const VERSION_LABEL = /^(?:live|acoustic|demo|remix(?:ed)?|instrumental|karaoke|radio|edit|cover|session|unplugged|a cappella|rehearsal|alternate|alternative|early|rough|single|album|extended|original mix|\d{4} (?:remix|mix|version))\b/i;

function versionLabel(disambiguation: string): string {
    const head = disambiguation.split(/[,:;]/, 1)[0]?.trim() ?? "";
    return VERSION_LABEL.test(head) ? head : "";
}

/** The title as matched: the display title plus the recording's version label, if it has one. */
function scoringTitle(candidate: Candidate): string {
    const label = candidate.kind === "track" ? versionLabel(candidate.disambiguation) : "";
    return label ? `${candidate.title} (${label})` : candidate.title;
}

const MAX_ALT_TITLES = 12;

function distinctTitles(main: string, others: Array<string | undefined>): string[] {
    const seen = new Set<string>([main]);
    for (const other of others) {
        const title = other?.trim();
        if (title) seen.add(title);
        if (seen.size > MAX_ALT_TITLES) break;
    }
    seen.delete(main);
    return [...seen];
}

function limitTo(config: SearchConfig): number {
    return Math.min(Math.max(config.candidatePool, 5), 100);
}

function creditNames(credits: RawArtistCredit[]): string[] {
    const names = new Set<string>();
    for (const credit of credits) {
        for (const value of [credit.name, credit.artist.name, credit.artist["sort-name"]]) if (value) names.add(value);
        for (const alias of credit.artist.aliases ?? []) {
            if (alias.name) names.add(alias.name);
            if (alias["sort-name"]) names.add(alias["sort-name"]);
        }
    }
    // a name in kana / hangul / Cyrillic also as the Latin letters somebody would type for it
    for (const name of [...names]) if (needsLatinForm(name)) names.add(latinize(name));
    // a multi-artist credit as one string: "A & B"
    if (credits.length > 1) {
        names.add(credits.map((credit) => `${credit.name ?? credit.artist.name}${credit.joinphrase ?? " "}`).join("").trim());
        names.add(credits.map((credit) => credit.artist.name).join(" "));
    }
    return [...names];
}

function creditDisplay(credits: RawArtistCredit[]): { name: string, id: string | null } {
    if (credits.length === 0) return { name: "Unknown Artist", id: null };
    const name = credits.map((credit) => `${credit.name ?? credit.artist.name}${credit.joinphrase ?? ""}`).join("").trim();
    return { name: credits.length > 1 ? name : credits[0]!.artist.name, id: credits[0]!.artist.id };
}

class Pipeline {
    private readonly normalized = new Map<string, NormalizedText>();
    private readonly failures: Error[] = [];
    // funnel counters, logged when a search comes back empty
    private readonly funnel = { candidates: 0, relevant: 0, qualified: 0 };
    private readonly intent: QueryIntent;
    private readonly interpretations: Interpretation[];

    constructor(readonly kind: "album" | "track", private readonly input: SearchInput, private readonly deps: SearchDeps) {
        this.interpretations = buildInterpretations(input, deps.config);
        this.intent = detectIntent([input.q, input.title, input.artist], deps.config);
    }

    private get config(): SearchConfig {
        return this.deps.config;
    }

    private norm(text: string): NormalizedText {
        let cached = this.normalized.get(text);
        if (!cached) {
            cached = normalizeText(text, this.config);
            this.normalized.set(text, cached);
        }
        return cached;
    }

    private log(message: string): void {
        this.deps.log?.(`[search:${this.kind}] ${message}`);
    }

    private async request<T>(path: string, query: string, limit = limitTo(this.config)): Promise<T | null> {
        try {
            return await this.deps.repo.request<T>(path, { query, limit });
        } catch (error) {
            // one failed angle must not sink the others; the circuit breaker / queue errors surface when
            // *nothing* could be retrieved (see `run`)
            this.log(`${path} failed: ${(error as Error).message}`);
            this.failures.push(error as Error);
            return null;
        }
    }

    // ---------------------------------------------------------------- recall

    private queryText(norm: NormalizedText): string {
        return norm.cleaned.replace(/[^\p{L}\p{N}\p{M}']+/gu, " ").trim();
    }

    private fieldClause(field: string, norm: NormalizedText | null, mode: "phrase" | "terms"): string | null {
        if (!norm) return null;
        const text = this.queryText(norm);
        if (!text) return null;
        return mode === "phrase" ? `${field}:${luceneQuote(text)}` : `${field}:(${luceneTerms(text)})`;
    }

    private join(clauses: Array<string | null>, extra?: string): string | null {
        const parts = [...clauses.filter((clause): clause is string => clause !== null), ...(extra ? [extra] : [])];
        return parts.length > 0 ? parts.join(" AND ") : null;
    }

    private candidateFromGroup(group: RawReleaseGroup, source: string): Candidate {
        return {
            kind: "album",
            id: group.id,
            title: group.title,
            disambiguation: "",
            credits: group["artist-credit"] ?? [],
            primaryType: group["primary-type"] ?? null,
            secondaryTypes: group["secondary-types"] ?? [],
            firstReleaseDate: group["first-release-date"] ?? null,
            length: null,
            releases: group.releases ?? [],
            altTitles: distinctTitles(group.title, (group.releases ?? []).map((release) => release.title)),
            code: null,
            sources: new Set([source]),
            qualifying: [],
            albumId: group.id
        };
    }

    private candidateFromRecording(recording: RawRecording, source: string): Candidate {
        return {
            kind: "track",
            id: recording.id,
            title: recording.title,
            disambiguation: recording.disambiguation ?? "",
            credits: recording["artist-credit"] ?? [],
            primaryType: null,
            secondaryTypes: [],
            firstReleaseDate: recording["first-release-date"] ?? null,
            length: recording.length ?? null,
            releases: recording.releases ?? [],
            altTitles: distinctTitles(recording.title, (recording.releases ?? []).flatMap((release) => (release.media ?? []).flatMap((medium) => (medium.track ?? []).map((track) => track.title)))),
            code: null,
            sources: new Set([source]),
            qualifying: [],
            albumId: null
        };
    }

    private add(pool: Map<string, Candidate>, candidate: Candidate): void {
        const existing = pool.get(candidate.id);
        if (!existing) {
            pool.set(candidate.id, candidate);
            return;
        }
        for (const source of candidate.sources) existing.sources.add(source);
        if (candidate.code && !existing.code) existing.code = candidate.code;
        if (existing.releases.length === 0) existing.releases = candidate.releases;
        if (candidate.altTitles.length > 0) existing.altTitles = distinctTitles(existing.title, [...existing.altTitles, ...candidate.altTitles]);
        if (existing.credits.length === 0) existing.credits = candidate.credits;
    }

    /** One search angle over every interpretation. */
    private async angle(pool: Map<string, Candidate>, source: string, build: (interpretation: Interpretation) => string | null, variants = false, limit = limitTo(this.config)): Promise<number> {
        const seen = new Set<string>();
        let found = 0;
        for (const interpretation of this.interpretations) {
            if (Boolean(interpretation.variant) !== variants) continue;
            const query = build(interpretation);
            if (!query || seen.has(query)) continue;
            seen.add(query);

            if (this.kind === "album" && source !== "recording-release") {
                const response = await this.request<ReleaseGroupSearch>("/release-group", query, limit);
                for (const group of response?.["release-groups"] ?? []) {
                    this.add(pool, this.candidateFromGroup(group, source));
                    found++;
                }
            } else {
                const response = await this.request<RecordingSearch>("/recording", query, limit);
                for (const recording of response?.recordings ?? []) {
                    if (this.kind === "track") {
                        this.add(pool, this.candidateFromRecording(recording, source));
                    } else {
                        this.addGroupsOfRecording(pool, recording, source);
                    }
                    found++;
                }
            }
        }
        return found;
    }

    // an album recalled through a recording: the release-groups its releases belong to
    private addGroupsOfRecording(pool: Map<string, Candidate>, recording: RawRecording, source: string): void {
        for (const release of recording.releases ?? []) {
            const group = release["release-group"];
            if (!group) continue;
            this.add(pool, {
                ...this.candidateFromGroup({
                    id: group.id,
                    title: group.title ?? release.title ?? "",
                    "primary-type": group["primary-type"],
                    "secondary-types": group["secondary-types"],
                    "artist-credit": recording["artist-credit"],
                    releases: [release]
                }, source)
            });
        }
    }

    /** Artist MBIDs for a requested artist name, found through MusicBrainz' alias-aware artist search. */
    private artistIdsMemo: Promise<string[]> | null = null;

    private artistIds(): Promise<string[]> {
        this.artistIdsMemo ??= this.lookupArtistIds();
        return this.artistIdsMemo;
    }

    private async lookupArtistIds(): Promise<string[]> {
        const ids = new Set<string>();
        const names = new Set<string>();
        for (const interpretation of this.interpretations) {
            if (interpretation.artist) names.add(this.queryText(interpretation.artist));
        }
        for (const name of names) {
            if (!name) continue;
            const query = `alias:${luceneQuote(name)} OR artist:${luceneQuote(name)} OR sortname:${luceneQuote(name)}`;
            const response = await this.request<ArtistSearch>("/artist", query, 5);
            for (const hit of (response?.artists ?? []).filter((artist) => (artist.score ?? 0) >= 85).slice(0, 3)) ids.add(hit.id);
        }
        return [...ids];
    }

    private async recallText(pool: Map<string, Candidate>): Promise<void> {
        const entity = this.kind === "album" ? "releasegroup" : "recording";
        const official = "status:official";

        // wave 1: the quoted phrase, then the same words unquoted
        await this.angle(pool, "phrase", (i) => this.join([this.fieldClause(entity, i.title, "phrase"), this.fieldClause("artist", i.artist, "phrase")], official));
        await this.angle(pool, "terms", (i) => this.join([this.fieldClause(entity, i.title, "terms"), this.fieldClause("artist", i.artist, "terms")], official));

        // wave 2, only when wave 1 was not convincing: other angles (alias/artist, recordings on a release of that name)
        if (!this.convincing(pool)) {
            const hasArtist = this.interpretations.some((i) => i.artist);
            if (hasArtist) {
                const ids = await this.artistIds();
                if (ids.length > 0) {
                    const arid = `arid:(${ids.join(" OR ")})`;
                    await this.angle(pool, "alias", (i) => (i.artist ? this.join([arid, this.fieldClause(entity, i.title, "terms")], official) : null));
                }
            }
            if (this.kind === "album") {
                await this.angle(pool, "recording-release", (i) => (i.title ? this.join([this.fieldClause("release", i.title, "phrase"), this.fieldClause("artist", i.artist, "phrase")], official) : null));
            }
        }

        // wave 3: the title in another script or spelling. MusicBrainz indexes the transliterated title a
        // Latin-script release gives a recording (and an alias of a release-group) under `alias`, which is
        // where "Hatachi no Koi" lives for 二十歳の恋; a typo gets one fuzzy try; romaji is also read as kana.
        if (!this.convincing(pool)) {
            await this.angle(pool, "title-alias", (i) => (i.title ? this.join([this.aliasClause(i.title, "phrase"), this.fieldClause("artist", i.artist, "phrase")], official) : null));
        }
        if (!this.convincing(pool)) {
            await this.angle(pool, "title-fuzzy", (i) => (i.title ? this.join([this.aliasClause(i.title, "fuzzy", entity), this.fieldClause("artist", i.artist, "terms")], official) : null));
            await this.angle(pool, "title-kana", (i) => (i.title ? this.join([this.fieldClause(entity, i.title, "phrase"), this.fieldClause("artist", i.artist, "phrase")], official) : null), true);
        }

        // wave 4: the artist is known (a Latin spelling finds the artist through its aliases) but no title matched:
        // MusicBrainz holds nothing searchable under the Latin title (a pseudo-release's track title is not indexed),
        // so take the artist's catalogue and let the scoring compare the title through its romanization
        if (!this.convincing(pool) && this.interpretations.some((i) => i.artist && i.title)) {
            const ids = await this.artistIds();
            if (ids.length > 0) {
                const arid = `arid:(${ids.join(" OR ")})`;
                await this.angle(pool, "artist-catalogue", (i) => (i.artist && i.title ? this.join([arid], official) : null), false, CATALOGUE_LIMIT);
            }
        }
    }

    /** `alias:"x"`, or for the fuzzy mode `(entity:(x~) OR alias:(x~))`. */
    private aliasClause(norm: NormalizedText, mode: "phrase" | "fuzzy", entity?: string): string | null {
        const text = this.queryText(norm);
        if (!text) return null;
        if (mode === "phrase") return `alias:${luceneQuote(text)}`;
        const terms = luceneFuzzyTerms(text);
        return `(${entity}:(${terms}) OR alias:(${terms}))`;
    }

    // is there already a near-perfect, plausible candidate? then the slower angles are skipped
    private convincing(pool: Map<string, Candidate>): boolean {
        for (const candidate of pool.values()) {
            const evaluated = this.evaluate(candidate);
            if (evaluated && evaluated.relevance >= 0.9) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- codes

    private async recallCodes(): Promise<Map<string, Candidate>> {
        const pool = new Map<string, Candidate>();

        if (this.kind === "album") {
            const upc = this.checkCode("upc", this.input.upc, parseUpc);
            if (upc) {
                const forms = barcodeForms(upc);
                const response = await this.request<ReleaseSearch>("/release", `barcode:(${forms.join(" OR ")})`, 25);
                for (const release of response?.releases ?? []) {
                    // MusicBrainz' barcode search is a text search and returns near-misses (a query of all zeros
                    // returned six unrelated releases): the barcode on the release must be the one asked for
                    if (!sameBarcode(release.barcode, upc)) continue;
                    const group = release["release-group"];
                    if (!group) continue;
                    const credits = (release as RawRelease & { "artist-credit"?: RawArtistCredit[] })["artist-credit"] ?? [];
                    const candidate = this.candidateFromGroup({
                        id: group.id,
                        title: group.title ?? release.title ?? "",
                        "primary-type": group["primary-type"],
                        "secondary-types": group["secondary-types"],
                        "artist-credit": credits,
                        releases: [release]
                    }, "upc");
                    candidate.code = { kind: "upc", value: upc };
                    this.add(pool, candidate);
                }
            }
        } else {
            const isrc = this.checkCode("isrc", this.input.isrc, parseIsrc);
            if (isrc) {
                const response = await this.request<RecordingSearch>("/recording", `isrc:${isrc}`, 25);
                for (const recording of response?.recordings ?? []) {
                    const isrcs = (recording.isrcs ?? []).map((entry) => (typeof entry === "string" ? entry : entry.id).toUpperCase());
                    if (isrcs.length > 0 && !isrcs.includes(isrc)) continue;
                    const candidate = this.candidateFromRecording(recording, "isrc");
                    candidate.code = { kind: "isrc", value: isrc };
                    this.add(pool, candidate);
                }
            }
        }
        return pool;
    }

    private checkCode(name: string, raw: string | undefined, parse: (input: unknown) => { value: string | null, reason?: string }): string | null {
        if (raw === undefined || raw === null || String(raw).trim() === "") return null;
        const parsed = parse(raw);
        if (!parsed.value) {
            this.log(`ignoring invalid ${name} "${raw}": ${parsed.reason}`);
            return null;
        }
        return parsed.value;
    }

    // ---------------------------------------------------------------- scoring

    private evaluate(candidate: Candidate): Evaluated | null {
        // works that can never qualify are dropped before they cost a request
        if (candidate.kind === "album" && !workPasses({ title: candidate.title, secondaryTypes: candidate.secondaryTypes }, this.intent, this.config)) return null;

        const forms = this.titleForms(candidate);
        const names = creditNames(candidate.credits).map((name) => this.norm(name));
        let best: Evaluated | null = null;

        for (const interpretation of this.interpretations) {
            const matched = interpretation.title ? this.bestTitle(interpretation.title, forms) : null;
            const title = matched?.score ?? null;
            const artist = interpretation.artist
                ? names.reduce((top, name) => Math.max(top, nameSimilarity(interpretation.artist!, name, this.config)), 0)
                : null;

            let contradicting = false;
            if (candidate.code) {
                contradicting = (title !== null && title.score < this.config.codeContradictionBelow)
                    || (artist !== null && artist < this.config.codeContradictionBelow);
            }
            const trusted = candidate.code !== null && !contradicting;

            if (!trusted) {
                if (artist !== null && artist < this.config.artistFloor) continue;

                // "different album" guard: extra distinctive words the request did not ask for. Only extras, never
                // missing words, and only when the artist is recognizably present - either the one requested, or
                // (no artist requested) the candidate's own artist named inside the requested title.
                if (title && interpretation.title) {
                    const extras = title.comparison.extraWords.length > 0 || title.comparison.extraChars >= this.config.cjkExtraCharsReject;
                    if (extras && this.artistPresent(interpretation, artist, names)) continue;
                }
            }

            const weights: Array<[number, number]> = [];
            if (title) weights.push([title.score, this.config.titleWeight]);
            if (artist !== null) weights.push([artist, this.config.artistWeight]);
            if (weights.length === 0) continue;
            const weightSum = weights.reduce((sum, [, weight]) => sum + weight, 0);
            let relevance = (weights.reduce((sum, [score, weight]) => sum + score * weight, 0) / weightSum) * interpretation.factor;

            const flags: MatchFlag[] = [...interpretation.flags];
            // found through another script: a transliterated title, a romanization, romaji read as kana
            if (matched && matched.via !== "native") {
                relevance *= this.config.transliterationFactor;
                if (!flags.includes("transliterated")) flags.push("transliterated");
            } else if (interpretation.variant) {
                relevance *= this.config.transliterationFactor;
            }
            if (candidate.code) {
                if (contradicting) {
                    relevance *= this.config.codeContradictionFactor;
                    flags.push("code_contradiction");
                } else {
                    flags.push(candidate.code.kind === "upc" ? "upc_match" : "isrc_match");
                }
            }

            if (!best || relevance > best.relevance) {
                best = {
                    candidate,
                    title: title?.score ?? 1,
                    artist: artist ?? 1,
                    exactness: interpretation.title && matched ? exactness(interpretation.title, matched.norm) : 1,
                    relevance,
                    flags
                };
            }
        }

        if (!best) return null;

        // corroboration and code bonuses sit on top of the base relevance
        const extraSources = Math.min((candidate.sources.size - 1) * this.config.corroborationBonus, this.config.corroborationBonusCap);
        best.relevance += Math.max(0, extraSources);
        if (best.flags.includes("upc_match") || best.flags.includes("isrc_match")) best.relevance += this.config.codeMatchBonus;
        return best;
    }

    private readonly formsCache = new WeakMap<Candidate, { signature: string, forms: TitleForm[] }>();

    /** Every way the candidate's title can be written: as MusicBrainz has it, as another release spells it, romanized. */
    private titleForms(candidate: Candidate): TitleForm[] {
        const signature = `${candidate.title}|${candidate.disambiguation}|${candidate.altTitles.join("|")}`;
        const cached = this.formsCache.get(candidate);
        if (cached?.signature === signature) return cached.forms;

        const label = candidate.kind === "track" ? versionLabel(candidate.disambiguation) : "";
        const withLabel = (title: string) => (label ? `${title} (${label})` : title);

        const forms: TitleForm[] = [{ norm: this.norm(scoringTitle(candidate)), via: "native", key: null }];
        for (const alt of candidate.altTitles) forms.push({ norm: this.norm(withLabel(alt)), via: "alt", key: null });
        if (needsLatinForm(candidate.title)) {
            forms.push({ norm: this.norm(withLabel(latinize(candidate.title))), via: "roman", key: phoneticKey(candidate.title) });
        }
        this.formsCache.set(candidate, { signature, forms });
        return forms;
    }

    /** The best score of the requested title against any form of the candidate's; a tie goes to the title itself. */
    private bestTitle(requested: NormalizedText, forms: TitleForm[]): { score: { score: number, comparison: Comparison }, via: TitleForm["via"], norm: NormalizedText } {
        let best: { score: { score: number, comparison: Comparison }, via: TitleForm["via"], norm: NormalizedText } | null = null;
        for (const form of forms) {
            const score = titleScore(requested, form.norm, this.config);
            if (!best || score.score > best.score.score + 1e-9) best = { score, via: form.via, norm: form.norm };
        }

        // a romanization has no word boundaries for kana and hangul ("yumeutsutsu"), so a spaced request is also
        // compared as one phonetic string. Only between a script that needs a Latin form and the Latin request
        // (or the reverse), never between two ordinary Latin titles.
        const romanForm = forms.find((form) => form.key !== null);
        if (romanForm && best!.score.score < 0.95) {
            const score = phoneticScore(phoneticKey(requested.cleaned), romanForm.key!);
            if (score > best!.score.score) {
                const comparison: Comparison = { coverage: score, candidateCoverage: score, extraWords: [], extraChars: 0, missingWords: [], dice: score };
                best = { score: { score, comparison }, via: "roman", norm: romanForm.norm };
            }
        }
        return best!;
    }

    private artistPresent(interpretation: Interpretation, artistScore: number | null, names: NormalizedText[]): boolean {
        if (interpretation.artist) return (artistScore ?? 0) >= this.config.artistFloor;
        if (!interpretation.title) return false;
        for (const name of names) {
            if (name.distinctive.length === 0 && name.cjk.length === 0) continue;
            // how much of the candidate's artist name is spelled out inside the requested title
            if (compareNormalized(name, interpretation.title, this.config).coverage >= this.config.artistFloor) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- verification

    private async digitalReleases(ids: string[], field: "rgid" | "reid"): Promise<Map<string, RawRelease[]>> {
        const found = new Map<string, RawRelease[]>();
        const batchSize = field === "rgid" ? 6 : 12;

        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            const query = `${field}:(${batch.join(" OR ")}) AND status:official AND format:${luceneQuote("Digital Media")}`;
            const response = await this.request<ReleaseSearch>("/release", query, 100);
            const releases = response?.releases ?? [];
            for (const release of releases) {
                const key = field === "rgid" ? release["release-group"]?.id : release.id;
                if (!key) continue;
                const list = found.get(key) ?? [];
                list.push(release);
                found.set(key, list);
            }

            // a full page may have crowded some groups out; ask for those one by one
            if (field === "rgid" && (response?.count ?? 0) > releases.length) {
                for (const id of batch.filter((candidate) => !found.has(candidate))) {
                    const single = await this.request<ReleaseSearch>("/release", `rgid:${id} AND status:official AND format:${luceneQuote("Digital Media")}`, 25);
                    if (single?.releases?.length) found.set(id, single.releases);
                }
            }
        }
        return found;
    }

    private async verify(evaluated: Evaluated[]): Promise<Evaluated[]> {
        if (evaluated.length === 0) return [];

        if (this.kind === "album") {
            const releases = await this.digitalReleases(evaluated.map((entry) => entry.candidate.id), "rgid");
            for (const entry of evaluated) entry.candidate.releases = releases.get(entry.candidate.id) ?? [];
        } else {
            // the recording payload carries status and media for each release; any release without media is checked in a batch
            const unknown = new Set<string>();
            for (const entry of evaluated) {
                for (const release of entry.candidate.releases) if (release.media === undefined) unknown.add(release.id);
            }
            if (unknown.size > 0) {
                const checked = await this.digitalReleases([...unknown], "reid");
                for (const entry of evaluated) {
                    entry.candidate.releases = entry.candidate.releases.flatMap((release) =>
                        release.media === undefined ? (checked.get(release.id) ?? []).map((full) => ({ ...release, ...full, "release-group": release["release-group"] ?? full["release-group"] })) : [release]);
                }
            }
        }

        const survivors: Evaluated[] = [];
        for (const entry of evaluated) {
            const candidate = entry.candidate;
            const qualifying = candidate.releases.filter((release) => {
                const group = release["release-group"];
                return releaseQualifies(
                    release,
                    {
                        title: group?.title ?? (candidate.kind === "album" ? candidate.title : release.title ?? ""),
                        secondaryTypes: group?.["secondary-types"] ?? candidate.secondaryTypes
                    },
                    this.intent,
                    this.config
                );
            });
            if (qualifying.length === 0) continue;

            const rank = (release: RawRelease) => {
                const type = (release["release-group"]?.["primary-type"] ?? candidate.primaryType ?? "other").toLowerCase();
                const index = this.config.primaryTypeOrder.indexOf(type as never);
                return index === -1 ? this.config.primaryTypeOrder.length : index;
            };
            // albums: earliest official digital release; tracks (payload has no dates): album before EP before single
            qualifying.sort((a, b) => candidate.kind === "album"
                ? sortableDate(a.date).localeCompare(sortableDate(b.date))
                : rank(a) - rank(b));
            candidate.qualifying = qualifying;

            const best = qualifying[0]!;
            // the edition asked for wins the tie against the plain one: they are the same work, and dedupe keeps one
            const label = `${best.title ?? ""} ${best.disambiguation ?? ""} ${candidate.title}`;
            if ((this.intent.wantsDeluxe && hasDeluxeKeyword(label, this.config)) || (this.intent.wantsRemaster && hasRemasterKeyword(label, this.config))) {
                entry.relevance += EDITION_NUDGE;
            }
            if (candidate.kind === "track") {
                const group = best["release-group"];
                candidate.albumId = group?.id ?? null;
                candidate.primaryType = group?.["primary-type"] ?? null;
                candidate.secondaryTypes = group?.["secondary-types"] ?? [];
            } else if (!candidate.firstReleaseDate && best.date) {
                candidate.firstReleaseDate = best.date;
            }
            survivors.push(entry);
        }
        return survivors;
    }

    private async withCovers(entries: Evaluated[]): Promise<Scored[]> {
        const out: Scored[] = [];
        let cursor = 0;
        const worker = async () => {
            for (;;) {
                const index = cursor++;
                const entry = entries[index];
                if (!entry) return;
                const best = entry.candidate.qualifying[0]!;
                const hasFrontCover = await this.deps.cover.hasFront({
                    releaseId: best.id,
                    releaseGroupId: entry.candidate.kind === "album" ? entry.candidate.id : entry.candidate.albumId,
                    known: best["cover-art-archive"]
                });
                out[index] = { ...entry, hasFrontCover };
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.config.coverArtConcurrency, entries.length) }, worker));
        return out;
    }

    // ---------------------------------------------------------------- run

    private async evaluateAll(pool: Map<string, Candidate>): Promise<Scored[]> {
        const prescored: Evaluated[] = [];
        for (const candidate of pool.values()) {
            const evaluated = this.evaluate(candidate);
            // the relevance gate runs before anything else can look at a candidate, covers included
            if (evaluated && evaluated.relevance >= this.config.minRelevance) prescored.push(evaluated);
        }
        prescored.sort((a, b) => b.relevance - a.relevance);

        // albums need a network round trip per batch of release-groups, so only the most relevant are verified;
        // a recording's releases arrive with the search itself, so every plausible one is filtered for free
        const budget = this.kind === "album" ? this.config.maxVerified : this.config.candidatePool;
        const verified = await this.verify(prescored.slice(0, budget));

        // the HEAD requests are what costs for tracks: best first, and among equals the work with the most
        // qualifying releases (the canonical recording, not a one-off)
        verified.sort((a, b) => b.relevance - a.relevance || b.candidate.qualifying.length - a.candidate.qualifying.length);
        this.funnel.candidates += pool.size;
        this.funnel.relevant += prescored.length;
        this.funnel.qualified += verified.length;
        return this.withCovers(verified.slice(0, this.config.maxVerified));
    }

    async run(): Promise<SearchResult[]> {
        if (this.interpretations.length === 0) return [];

        const evaluated = new Map<string, Scored>();
        const merge = (entries: Scored[]) => {
            for (const entry of entries) {
                const existing = evaluated.get(entry.candidate.id);
                if (!existing || entry.relevance > existing.relevance) evaluated.set(entry.candidate.id, entry);
            }
        };

        const codePool = await this.recallCodes();
        let codeEntries: Scored[] = [];
        if (codePool.size > 0) codeEntries = await this.evaluateAll(codePool);
        merge(codeEntries);

        // fall back to title + artist when the code gave nothing usable (no hit, every hit filtered out, or every
        // survivor contradicting what was asked for) - a failed code must never empty the response
        const trusted = codeEntries.some((entry) => !entry.flags.includes("code_contradiction"));
        if (!trusted) {
            if (codePool.size > 0 || this.input.upc || this.input.isrc) this.log("code lookup gave no usable result, falling back to title + artist");
            const pool = new Map<string, Candidate>();
            await this.recallText(pool);
            merge(await this.evaluateAll(pool));
        }

        if (evaluated.size === 0) {
            const { candidates, relevant, qualified } = this.funnel;
            this.log(`no result: ${candidates} candidates, ${relevant} relevant enough, ${qualified} with an official digital release`);
        }
        if (evaluated.size === 0 && this.failures.length > 0) {
            // nothing came back *and* MusicBrainz errored: say so instead of presenting an empty result as "no match"
            throw this.failures[0];
        }

        const results = [...evaluated.values()].map((entry) => this.toResult(entry));
        results.sort((a, b) => compareResults(a, b, this.config.primaryTypeOrder));
        return markBestResult(dedupe(results, this.kind, this.config), this.config);
    }

    private toResult(entry: Scored): SearchResult {
        const { candidate } = entry;
        const best = candidate.qualifying[0]!;
        const flags = [...entry.flags];
        if (!entry.hasFrontCover) flags.push("no_front_cover");
        return {
            kind: candidate.kind,
            id: candidate.id,
            title: candidate.title,
            artist: creditDisplay(candidate.credits),
            primaryType: candidate.primaryType,
            secondaryTypes: candidate.secondaryTypes,
            releaseDate: candidate.kind === "album" ? (best.date ?? candidate.firstReleaseDate) : (candidate.firstReleaseDate ?? best.date ?? null),
            releaseId: best.id,
            releaseTitle: best.title ?? null,
            albumId: candidate.albumId,
            length: candidate.length,
            hasFrontCover: entry.hasFrontCover,
            match: {
                title: round(entry.title),
                artist: round(entry.artist),
                relevance: round(entry.relevance),
                exactness: round(entry.exactness),
                sources: candidate.sources.size,
                flags
            },
            bestResult: false
        };
    }
}

interface TitleForm {
    norm: NormalizedText,
    via: "native" | "alt" | "roman",
    /** `phoneticKey` of the native title, set on the romanized form only. */
    key: string | null
}

/**
 * How alike two phonetic keys are: 0 below a close match. A key that merely contains the request scores by the
 * share of it, which charges for what the request did not ask for.
 */
function phoneticScore(requestedKey: string, candidateKey: string): number {
    if (requestedKey.length < 4 || candidateKey.length < 4) return 0;
    const ratio = levenshteinRatio(requestedKey, candidateKey);
    if (ratio >= 0.85) return ratio;
    if (requestedKey.length >= 6 && candidateKey.includes(requestedKey)) return Math.min(0.9, requestedKey.length / candidateKey.length);
    return 0;
}

function round(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------- ranking

const SCORE_RESOLUTION = 1000;

/**
 * Lexicographic ranking:
 *   1. HAS FRONT COVER (true before false)
 *   2. relevance            3. artist score      4. title exactness (Levenshtein)
 *   5. primary type (Album > EP > Single, configurable)
 *   6. earliest official digital release date    7. MBID, so the order is stable
 *
 * The cover is the first key *on purpose*: Nafyn shows a cover for everything it lists, and a result with
 * none renders as a blank card that looks broken. So a correct match without a front cover ranks below a
 * covered, relevant one by design. That can only ever reorder results that already cleared the relevance gate
 * (`minRelevance`), applied before ranking, so an irrelevant cover can never surface this way. The cost is
 * reflected in `best_result`, which refuses to flag a top result that is not clearly ahead on score.
 *
 * Scores are compared at 3 decimals so that float noise does not decide the order ahead of the later keys.
 */
export function compareResults(a: SearchResult, b: SearchResult, order: string[] = ["album", "ep", "single", "broadcast", "other"]): number {
    if (a.hasFrontCover !== b.hasFrontCover) return a.hasFrontCover ? -1 : 1;

    const bucket = (value: number) => Math.round(value * SCORE_RESOLUTION);
    if (bucket(a.match.relevance) !== bucket(b.match.relevance)) return bucket(b.match.relevance) - bucket(a.match.relevance);
    if (bucket(a.match.artist) !== bucket(b.match.artist)) return bucket(b.match.artist) - bucket(a.match.artist);
    if (bucket(a.match.exactness) !== bucket(b.match.exactness)) return bucket(b.match.exactness) - bucket(a.match.exactness);

    const typeRank = (result: SearchResult) => {
        const index = order.indexOf((result.primaryType ?? "other").toLowerCase());
        return index === -1 ? order.length : index;
    };
    if (typeRank(a) !== typeRank(b)) return typeRank(a) - typeRank(b);

    const dateOrder = sortableDate(a.releaseDate).localeCompare(sortableDate(b.releaseDate));
    if (dateOrder !== 0) return dateOrder;

    return a.id.localeCompare(b.id);
}

const LENGTH_TOLERANCE_MS = 3000;

/** The same work across editions/regions: first (best-ranked) wins. */
export function dedupe(ranked: SearchResult[], kind: "album" | "track", config: SearchConfig): SearchResult[] {
    const normalize = (text: string) => normalizeText(text, config).text;
    const kept: Array<{ key: string, result: SearchResult }> = [];
    for (const result of ranked) {
        const key = `${normalize(result.title)}|${normalize(result.artist.name)}`;
        const duplicate = kept.some((other) => {
            if (other.key !== key) return false;
            if (kind === "album") return true;
            if (other.result.length === null || result.length === null) return true;
            return Math.abs(other.result.length - result.length) <= LENGTH_TOLERANCE_MS;
        });
        if (!duplicate) kept.push({ key, result });
    }
    return kept.map((entry) => entry.result);
}

/**
 * At most one result is flagged, and only if the top-ranked one (a) clears `bestResultMinScore`, (b) has a front
 * cover or an exact UPC/ISRC match, and (c) beats the runner-up's score by `bestResultMargin`. Anything closer is
 * ambiguous and nobody is flagged; the consumer still gets the whole ranked list.
 */
export function markBestResult(ranked: SearchResult[], config: SearchConfig): SearchResult[] {
    for (const result of ranked) result.bestResult = false;
    const top = ranked[0];
    if (!top) return ranked;

    const exactCode = top.match.flags.includes("upc_match") || top.match.flags.includes("isrc_match");
    const second = ranked[1];
    const margin = top.match.relevance - (second?.match.relevance ?? 0);

    if (top.match.relevance >= config.bestResultMinScore && (top.hasFrontCover || exactCode) && margin >= config.bestResultMargin) {
        top.bestResult = true;
    }
    return ranked;
}

// ---------------------------------------------------------------- entry points

function page(results: SearchResult[], limit: number, offset: number): SearchPage {
    return { results: results.slice(offset, offset + limit), total: results.length };
}

export async function searchAlbums(input: SearchInput, deps: SearchDeps, limit = 20, offset = 0): Promise<SearchPage> {
    return page(await new Pipeline("album", input, deps).run(), limit, offset);
}

export async function searchTracks(input: SearchInput, deps: SearchDeps, limit = 20, offset = 0): Promise<SearchPage> {
    return page(await new Pipeline("track", input, deps).run(), limit, offset);
}
