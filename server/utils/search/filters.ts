// Hard filters: a result failing one of these is not returned, whatever its relevance.
//
//   * release status must be Official (no Bootleg, Promotion, Pseudo-Release)
//   * the work needs an Official release on "Digital Media" - the only format Nafyn can match on Soulseek
//   * Deluxe and Remaster editions of an ALBUM are out unless the query asked for one - but a TRACK is found
//     through a Deluxe edition (bonus tracks live nowhere else); see `releaseQualifies`'s `tracks` option
//   * Live and Remix works (a Live / Remix release-group, a "(Live ...)" title, a recording whose version is
//     "live", "acoustic", "demo"...) are out unless the query itself says so
//   * Compilations and "Best of" / greatest-hits titles are out; a query that itself says "best of" lifts
//     the *title heuristic* only - a release-group typed Compilation stays out
//   * secondary types that are never the artist's own release (demo, interview, audiobook...)

import type { SearchConfig } from "./config";
import { containsPhrase, foldForKeywords } from "./normalize";
import type { RawRelease } from "./types";

export interface QueryIntent {
    wantsDeluxe: boolean,
    wantsRemaster: boolean,
    /** The query says "live" (or its translation): live albums and live recordings may be returned. */
    wantsLive: boolean,
    /** The query says "remix": remix albums and remixed recordings may be returned. */
    wantsRemix: boolean,
    /** Other version words (acoustic, demo, instrumental...) the query itself contains, folded. */
    wantedVersions: string[],
    /** The query itself contains a best-of keyword: the title heuristic is not applied. */
    wantsCompilation: boolean
}

interface FoldedKeywords {
    compilation: string[],
    deluxe: string[],
    remaster: string[],
    live: string[],
    remix: string[]
}

const keywordCache = new WeakMap<SearchConfig, FoldedKeywords>();

function folded(config: SearchConfig): FoldedKeywords {
    let cached = keywordCache.get(config);
    if (!cached) {
        const fold = (list: string[]) => [...new Set(list.map(foldForKeywords).filter(Boolean))];
        cached = {
            compilation: fold(config.compilationKeywords),
            deluxe: fold(config.deluxeKeywords),
            remaster: fold(config.remasterKeywords),
            live: fold(config.liveKeywords),
            remix: fold(config.remixKeywords)
        };
        keywordCache.set(config, cached);
    }
    return cached;
}

// "remaster" must catch "remastered"/"remasterisée" too: a single-word latin keyword matches as a word prefix
function matchesKeyword(foldedText: string, keyword: string): boolean {
    if (containsPhrase(foldedText, keyword)) return true;
    if (/[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Hangul}]/u.test(keyword)) return false;
    return foldedText.split(" ").some((word) => word.startsWith(keyword) && keyword.length >= 5);
}

function matchesAny(foldedText: string, keywords: string[]): boolean {
    return keywords.some((keyword) => matchesKeyword(foldedText, keyword));
}

export function hasCompilationKeyword(text: string, config: SearchConfig): boolean {
    return matchesAny(foldForKeywords(text), folded(config).compilation);
}

export function hasDeluxeKeyword(text: string, config: SearchConfig): boolean {
    return matchesAny(foldForKeywords(text), folded(config).deluxe);
}

export function hasRemasterKeyword(text: string, config: SearchConfig): boolean {
    return matchesAny(foldForKeywords(text), folded(config).remaster);
}

export function hasLiveKeyword(text: string, config: SearchConfig): boolean {
    return matchesAny(foldForKeywords(text), folded(config).live);
}

export function hasRemixKeyword(text: string, config: SearchConfig): boolean {
    return matchesAny(foldForKeywords(text), folded(config).remix);
}

// A recording's version, as MusicBrainz writes it in the disambiguation ("live, 1975: Earls Court", "acoustic",
// "2007 remix"). Only the leading word counts - never the venue or the date that follows it. "radio edit",
// "single version", "album version" and "extended" are deliberately absent: those are the song as released.
const EXCLUDED_VERSIONS = /^(?:live|acoustic|demo|remix(?:ed)?|\d{4} remix|instrumental|karaoke|cover|session|unplugged|a cappella|rehearsal|rough|early|alternate|alternative|sped up|slowed)\b/i;

/** The version a recording's disambiguation names ("live", "remix", "acoustic"...), or null when it is the song as released. */
export function recordingVersion(disambiguation: string | undefined | null): string | null {
    const head = (disambiguation ?? "").split(/[,:;]/, 1)[0]?.trim() ?? "";
    const match = EXCLUDED_VERSIONS.exec(head);
    if (!match) return null;
    const word = foldForKeywords(match[0]);
    return word.endsWith(" remix") || word.startsWith("remix") ? "remix" : word;
}

// "(Live)", "[Live at Wembley]", "Song - Live", "Live at the BBC", "Song (Remix)": a version that is in the title
// itself because nobody typed it in the disambiguation
const LIVE_TITLE = /(?:[([]\s*live\b|[-–—:]\s*live\b|^live (?:at|in|from|on|au|à|en|im)\b)/iu;
const REMIX_TITLE = /(?:[([\-–—][^)\]]*\b(?:remix|remixed|rmx|re-?work)\b|\b(?:remix|remixes)\s*[)\]]?\s*$)/iu;

function titleIsLive(title: string): boolean {
    return LIVE_TITLE.test(title);
}

function titleIsRemix(title: string): boolean {
    return REMIX_TITLE.test(title);
}

export function detectIntent(texts: Array<string | null | undefined>, config: SearchConfig): QueryIntent {
    const joined = texts.filter(Boolean).join(" ");
    const folded = foldForKeywords(joined);
    return {
        wantsDeluxe: hasDeluxeKeyword(joined, config),
        wantsRemaster: hasRemasterKeyword(joined, config),
        wantsLive: hasLiveKeyword(joined, config),
        wantsRemix: hasRemixKeyword(joined, config),
        wantedVersions: ["acoustic", "demo", "instrumental", "karaoke", "cover", "session", "unplugged", "a cappella", "rehearsal", "rough", "early", "alternate", "alternative", "sped up", "slowed"]
            .filter((word) => containsPhrase(folded, word)),
        wantsCompilation: hasCompilationKeyword(joined, config)
    };
}

/**
 * Recording level (tracks only): is this recording the song as released, or a version the query asked for? A live,
 * remixed, acoustic... recording is only returned when the query says so.
 */
export function recordingPasses(recording: { title: string, disambiguation?: string }, intent: QueryIntent): boolean {
    const version = recordingVersion(recording.disambiguation);
    if (version === "live" || version === "unplugged") {
        if (!intent.wantsLive && !intent.wantedVersions.includes(version)) return false;
    } else if (version === "remix") {
        if (!intent.wantsRemix) return false;
    } else if (version !== null && !intent.wantedVersions.includes(version)) {
        return false;
    }
    if (!intent.wantsLive && titleIsLive(recording.title)) return false;
    if (!intent.wantsRemix && titleIsRemix(recording.title)) return false;
    return true;
}

export function hasExcludedSecondaryType(secondaryTypes: string[] | undefined, config: SearchConfig): boolean {
    const excluded = new Set(config.excludedSecondaryTypes.map((type) => type.toLowerCase()));
    return (secondaryTypes ?? []).some((type) => excluded.has(type.toLowerCase()));
}

export interface WorkInfo {
    title: string,
    secondaryTypes?: string[]
}

function hasSecondaryType(secondaryTypes: string[] | undefined, wanted: string): boolean {
    return (secondaryTypes ?? []).some((type) => type.toLowerCase() === wanted);
}

/** Release-group / work level: does the work itself pass? (Needs no network.) */
export function workPasses(work: WorkInfo, intent: QueryIntent, config: SearchConfig): boolean {
    if (hasExcludedSecondaryType(work.secondaryTypes, config)) return false;
    if (!intent.wantsLive && (hasSecondaryType(work.secondaryTypes, "live") || titleIsLive(work.title))) return false;
    if (!intent.wantsRemix && (hasSecondaryType(work.secondaryTypes, "remix") || hasSecondaryType(work.secondaryTypes, "dj-mix"))) return false;
    if (!intent.wantsCompilation && hasCompilationKeyword(work.title, config)) return false;
    if (!intent.wantsDeluxe && hasDeluxeKeyword(work.title, config)) return false;
    if (!intent.wantsRemaster && hasRemasterKeyword(work.title, config)) return false;
    return true;
}

export function isOfficial(release: RawRelease): boolean {
    return release.status?.toLowerCase() === "official";
}

export function isDigital(release: RawRelease): boolean {
    return (release.media ?? []).some((medium) => medium.format === "Digital Media");
}

/**
 * Release level: Official + Digital Media (unless `config.requireDigitalMedia` is off) + not a Deluxe/Remaster
 * edition (unless asked for).
 * `work` is the release-group the release belongs to - its title and types apply too.
 *
 * `tracks`: the release is judged for a *track* of it. A song is found on a Deluxe edition (it may be a bonus
 * track that is on no other release), so the Deluxe wording of the release or of its group is not held against
 * it - `releaseQualifies` then behaves as if the query had asked for Deluxe. Remasters, Live and the rest still
 * need to be asked for.
 */
export function releaseQualifies(release: RawRelease, work: WorkInfo, intent: QueryIntent, config: SearchConfig, options: { tracks?: boolean } = {}): boolean {
    if (!isOfficial(release) || (config.requireDigitalMedia && !isDigital(release))) return false;
    if (options.tracks && !intent.wantsDeluxe) intent = { ...intent, wantsDeluxe: true };
    if (!workPasses(work, intent, config)) return false;
    const label = `${release.title ?? ""} ${release.disambiguation ?? ""}`;
    if (!intent.wantsDeluxe && hasDeluxeKeyword(label, config)) return false;
    if (!intent.wantsRemaster && hasRemasterKeyword(label, config)) return false;
    return true;
}

/** "YYYY", "YYYY-MM" or "YYYY-MM-DD" padded so plain string comparison orders them; undated sorts last. */
export function sortableDate(date: string | undefined | null): string {
    if (!date) return "9999-99-99";
    const [year = "9999", month = "00", day = "00"] = date.split("-");
    return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
