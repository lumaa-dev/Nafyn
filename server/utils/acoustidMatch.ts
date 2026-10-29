// scoring of AcoustID candidates against the recording a download was requested as.
//
// Pure on purpose (no Nitro auto-imports, no network, no filesystem) so it runs under `bun test`, like
// server/utils/search/. The caller (utils/fingerprint.ts) measures the fingerprint and duration from the audio
// itself and fetches the candidates; nothing stored anywhere - no AcoustID UUID, no tag, no database column,
// no user-supplied length - ever reaches this file. A single returned ID is never trusted on its own: every
// candidate is filtered by score and by how far its duration is from the *measured* one, ranked, and only then
// compared with what was requested.

import { needsLatinForm, phoneticKey } from "./search/script";

export interface AcoustIdRecording {
    id: string,
    title?: string,
    // seconds
    duration?: number,
    artists?: { id?: string, name?: string }[]
}

export interface AcoustIdResult {
    id: string,
    score: number,
    recordings?: AcoustIdRecording[]
}

export interface Candidate {
    id: string,
    score: number,
    title: string,
    artist: string,
    // seconds; null when AcoustID doesn't know the recording's length (never a reason to drop it)
    duration: number | null,
    durationDelta: number | null
}

export interface ExpectedRecording {
    recordingId: string,
    // other MBIDs naming the same recording (what a track request carried before MusicBrainz redirected it)
    aliases: string[],
    title: string,
    artistName: string,
    // the same work and artist under other names (a Latin-script release's title, sort names, other credits):
    // AcoustID often lists a Japanese song under its romanized title, which is still the same song
    altTitles?: string[],
    artistAliases?: string[],
    // seconds, 0 when MusicBrainz doesn't know it
    duration: number
}

export interface MatchConfig {
    // an AcoustID score below this is noise
    minScore: number,
    // a candidate whose known length is further than this from the measured audio is a different recording
    // (live take, edit, extended mix) even when the fingerprint is close
    durationTolerance: number,
    // title + artist agreement alone (different MBID) is only believed at this score or above
    identityMinScore: number,
    // a candidate at/above this score that is a different song means the file is very probably the wrong one
    confidentScore: number,
    // merged-away MBIDs looked up on MusicBrainz per file
    maxAliasLookups: number
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
    minScore: 0.7,
    durationTolerance: 5,
    identityMinScore: 0.85,
    confidentScore: 0.9,
    maxAliasLookups: 3
};

function numberFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function readMatchConfig(env: Record<string, string | undefined> = process.env): MatchConfig {
    return {
        ...DEFAULT_MATCH_CONFIG,
        minScore: numberFromEnv(env.NAFYN_ACOUSTID_MIN_SCORE, DEFAULT_MATCH_CONFIG.minScore, 0, 1),
        durationTolerance: numberFromEnv(env.NAFYN_ACOUSTID_DURATION_TOLERANCE, DEFAULT_MATCH_CONFIG.durationTolerance, 0, 120),
        maxAliasLookups: Math.round(numberFromEnv(env.NAFYN_ACOUSTID_MAX_ALIAS_LOOKUPS, DEFAULT_MATCH_CONFIG.maxAliasLookups, 0, 10))
    };
}

// accents folded, punctuation gone; kept local (mediaIdentity.ts imports the Soulseek client, which needs Nitro)
function normalize(text: string): string {
    return text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// "Song (2011 Remaster)", "Song [Live]", "Song - Radio Edit" all name the same composition for the purpose of
// "is this obviously another song"; a bracketed suffix must not turn a right file into a wrong one
function baseTitle(title: string): string {
    return normalize(title.replace(/[([{][^)\]}]*[)\]}]/g, " ").replace(/\s[-–—]\s.*$/, " "));
}

// across scripts (さよならの夏 / "Sayonara no Natsu") only a phonetic skeleton can compare - on the raw text, the
// accent fold above would take the dakuten off が. It is lossy, so it needs a few letters to mean anything. Kanji
// have no reading here: 二十歳の恋 / "Hatachi no Koi" is caught through `altTitles` (MusicBrainz' Latin release title).
const MIN_PHONETIC_KEY = 4;

function samePhonetic(a: string, b: string): boolean {
    if (!needsLatinForm(a) && !needsLatinForm(b)) return false;
    const left = phoneticKey(a);
    const right = phoneticKey(b);
    if (left.length < MIN_PHONETIC_KEY || right.length < MIN_PHONETIC_KEY) return false;
    return left === right || left.includes(right) || right.includes(left);
}

function sameTitle(a: string, b: string): boolean {
    const left = baseTitle(a);
    const right = baseTitle(b);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left) || samePhonetic(a, b);
}

function sameArtist(candidate: string, expected: string): boolean {
    const left = normalize(candidate);
    const right = normalize(expected);
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left) || samePhonetic(candidate, expected);
}

function isSameSong(candidate: Candidate, expected: ExpectedRecording): boolean {
    const titles = [expected.title, ...(expected.altTitles ?? [])];
    const artists = [expected.artistName, ...(expected.artistAliases ?? [])];
    return titles.some((title) => sameTitle(candidate.title, title)) && artists.some((artist) => sameArtist(candidate.artist, artist));
}

// one entry per recording ID (its best score across every AcoustID result that lists it), noise and
// wrong-length recordings dropped, best first. Deterministic: ties fall to the closer duration, then the ID.
export function rankCandidates(results: AcoustIdResult[], measuredDuration: number, config: MatchConfig = DEFAULT_MATCH_CONFIG): Candidate[] {
    const best = new Map<string, Candidate>();

    for (const result of results) {
        if (!(result.score >= config.minScore)) continue;
        for (const recording of result.recordings ?? []) {
            if (!recording?.id) continue;
            const id = recording.id.toLowerCase();
            const duration = typeof recording.duration === "number" && recording.duration > 0 ? recording.duration : null;
            const durationDelta = duration !== null && measuredDuration > 0 ? Math.abs(duration - measuredDuration) : null;
            if (durationDelta !== null && durationDelta > config.durationTolerance) continue;

            const existing = best.get(id);
            if (existing && existing.score >= result.score) continue;
            best.set(id, {
                id,
                score: result.score,
                title: recording.title ?? "",
                artist: (recording.artists ?? []).map((artist) => artist.name ?? "").filter(Boolean).join(", "),
                duration,
                durationDelta
            });
        }
    }

    return [...best.values()].sort((a, b) =>
        b.score - a.score
        || (a.durationDelta ?? Number.POSITIVE_INFINITY) - (b.durationDelta ?? Number.POSITIVE_INFINITY)
        || a.id.localeCompare(b.id)
    );
}

export interface Verdict {
    matched: boolean,
    via: "mbid" | "alias" | "identity" | null,
    best: Candidate | null,
    // a high-confidence candidate that is a different song: the file is almost certainly not what was requested
    confidentOther: Candidate | null
}

// `canonical` maps a candidate's ID to the surviving MBID MusicBrainz resolves it to (merged recordings), as
// looked up by the caller for the few candidates worth the request. `aliasesComplete` false means some of those
// lookups couldn't be made (MusicBrainz busy): a confident "other" candidate may then be the requested recording
// under a merged-away ID nobody could check, so it is not reported as a contradiction - the caller's duration
// rule decides instead. Rejecting a right file needs a complete check.
export function judge(
    candidates: Candidate[],
    expected: ExpectedRecording,
    config: MatchConfig = DEFAULT_MATCH_CONFIG,
    canonical: ReadonlyMap<string, string> = new Map(),
    aliasesComplete = true
): Verdict {
    const primary = expected.recordingId.toLowerCase();
    const aliases = new Set(expected.aliases.map((id) => id.toLowerCase()));
    aliases.delete(primary);

    const kindOf = (candidate: Candidate): "mbid" | "alias" | null => {
        const ids = [candidate.id, canonical.get(candidate.id)?.toLowerCase()].filter((id): id is string => !!id);
        if (ids.includes(primary)) return "mbid";
        if (ids.some((id) => aliases.has(id))) return "alias";
        return null;
    };

    // candidates are ranked, so the first hit of the strongest kind is the best one
    for (const candidate of candidates) {
        const via = kindOf(candidate);
        if (via) return { matched: true, via, best: candidate, confidentOther: null };
    }

    for (const candidate of candidates) {
        if (candidate.score >= config.identityMinScore && isSameSong(candidate, expected)) {
            return { matched: true, via: "identity", best: candidate, confidentOther: null };
        }
    }

    const confidentOther = aliasesComplete
        ? candidates.find((candidate) => candidate.score >= config.confidentScore && !isSameSong(candidate, expected)) ?? null
        : null;

    return { matched: false, via: null, best: candidates[0] ?? null, confidentOther };
}

// the unmatched candidates worth a MusicBrainz lookup to see whether they are the requested recording under
// a merged-away ID: strongest first, only ones that could still change the verdict
export function aliasLookupCandidates(candidates: Candidate[], expected: ExpectedRecording, config: MatchConfig = DEFAULT_MATCH_CONFIG): string[] {
    const known = new Set([expected.recordingId, ...expected.aliases].map((id) => id.toLowerCase()));
    return candidates
        .filter((candidate) => !known.has(candidate.id) && candidate.score >= config.identityMinScore)
        .slice(0, config.maxAliasLookups)
        .map((candidate) => candidate.id);
}
