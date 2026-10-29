// Picking the MusicBrainz recording for a track another service (Apple Music, ...) described: which of the
// recordings sharing an ISRC it is, which forms of its title and artist are worth searching for, and whether a
// search result is close enough to take. Pure (no Nitro auto-imports, no network), so it runs under `bun test`.
import { cleanText } from "./search/normalize";
import { levenshteinRatio } from "./search/similarity";
import type { SearchResult } from "./search/types";

export interface DescribedTrack {
    title?: string,
    artist?: string,
    /** Seconds, as the other service reports it. */
    duration?: number
}

// ---------------------------------------------------------------- title and artist forms

/**
 * The title without what catalogs disagree on: bracketed parts ("(feat. X)", "[Remastered]", "(From "Film")") and a
 * dashed suffix (" - Single Version", " - 2011 Remaster"). The text itself when nothing would be left.
 */
export function coreTitle(title: string): string {
    const core = title
        .replace(/\s*[([{][^)\]}]*[)\]}]/g, " ")
        .replace(/\s+[-–—]\s+.*$/, "")
        .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    return core || title.trim();
}

// "A & B", "A, B & C", "A x B", "A feat. B", "A with B": a streaming service's display string for several credits
const ARTIST_SEPARATOR = /\s*(?:,|&|\+|\/|;|\s(?:x|×|and|et|with|feat\.?|ft\.?|featuring|vs\.?)\s)\s*/i;

/** The first credited artist of a multi-artist display string, or null when it names only one. */
export function primaryArtist(artist: string): string | null {
    const parts = artist.split(ARTIST_SEPARATOR).map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 && parts[0]!.length >= 2 ? parts[0]! : null;
}

/**
 * The (title, artist) pairs to search for, most faithful first: as given, the core title, then the first artist
 * alone (only when the display string names several - "Simon & Garfunkel" is tried whole first).
 */
export function searchForms(title: string, artist: string): Array<{ title: string, artist: string }> {
    const titles = [...new Set([title.trim(), coreTitle(title)])].filter(Boolean);
    const artists = [artist.trim(), primaryArtist(artist)].filter((value): value is string => !!value);
    const forms: Array<{ title: string, artist: string }> = [];
    const seen = new Set<string>();
    for (const a of artists) {
        for (const t of titles) {
            const key = `${cleanText(t)}|${cleanText(a)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            forms.push({ title: t, artist: a });
        }
    }
    return forms;
}

// ---------------------------------------------------------------- ISRC: one code, several recordings

export interface IsrcRecording {
    id: string,
    title?: string,
    /** Milliseconds, as MusicBrainz gives it. */
    length?: number | null,
    "artist-credit"?: Array<{ name?: string, artist?: { name?: string, "sort-name"?: string } }>
}

function textSimilarity(a: string, b: string): number {
    const left = cleanText(coreTitle(a));
    const right = cleanText(coreTitle(b));
    if (!left || !right) return 0;
    if (left === right) return 1;
    return levenshteinRatio(left, right);
}

function artistSimilarity(wanted: string, recording: IsrcRecording): number {
    const target = cleanText(wanted);
    if (!target) return 0;
    let best = 0;
    for (const credit of recording["artist-credit"] ?? []) {
        for (const name of [credit.name, credit.artist?.name, credit.artist?.["sort-name"]]) {
            const candidate = cleanText(name ?? "");
            if (!candidate) continue;
            if (candidate === target || target.includes(candidate) || candidate.includes(target)) return 1;
            best = Math.max(best, levenshteinRatio(target, candidate));
        }
    }
    return best;
}

/** 1 within 3 s, 0.5 within 10 s or when either length is unknown, 0 beyond. */
export function durationAgreement(wantedSeconds: number | undefined, lengthMs: number | null | undefined): number {
    if (!wantedSeconds || !lengthMs) return 0.5;
    const delta = Math.abs(lengthMs / 1000 - wantedSeconds);
    if (delta <= 3) return 1;
    return delta <= 10 ? 0.5 : 0;
}

/**
 * The recording an ISRC lookup means for this track. MusicBrainz attaches one ISRC to every duplicate and every
 * edit of a recording, in no useful order; the one whose title, artist and length agree with what the other
 * service described wins, the first listed on a tie.
 */
export function pickIsrcRecording(recordings: IsrcRecording[], track: DescribedTrack): IsrcRecording | null {
    if (recordings.length <= 1) return recordings[0] ?? null;

    let best: IsrcRecording | null = null;
    let bestScore = -1;
    for (const recording of recordings) {
        const title = track.title ? textSimilarity(track.title, recording.title ?? "") : 0.5;
        const artist = track.artist ? artistSimilarity(track.artist, recording) : 0.5;
        const score = 0.5 * title + 0.3 * artist + 0.2 * durationAgreement(track.duration, recording.length);
        if (score > bestScore) {
            best = recording;
            bestScore = score;
        }
    }
    return best;
}

// ---------------------------------------------------------------- search fallback: take it or leave it

export interface AcceptOptions {
    /** What a result needs on its own, without a length to back it (the search page's `bestResult` bar). */
    minScore: number,
    /** What a result needs when its length agrees with the described one within 3 s. */
    durationMinScore: number
}

/**
 * The search result to import, or null - a guess is worse than "not found". Results come ranked; never one whose
 * code contradicts it. With a known length: a strong result that agrees on it, then a decent one that does, then a
 * strong one that isn't clearly another edit (more than 15 s off).
 */
export function acceptSearchResult(results: SearchResult[], track: DescribedTrack, options: AcceptOptions): SearchResult | null {
    const usable = results.filter((result) => !result.match.flags.includes("code_contradiction"));
    const agrees = (result: SearchResult) => durationAgreement(track.duration, result.length) === 1 && !!track.duration && !!result.length;
    const clashes = (result: SearchResult) => !!track.duration && !!result.length && Math.abs(result.length / 1000 - track.duration) > 15;
    const strong = (result: SearchResult) => result.match.relevance >= options.minScore;

    return usable.find((result) => strong(result) && agrees(result))
        ?? usable.find((result) => result.match.relevance >= options.durationMinScore && agrees(result))
        ?? usable.find((result) => strong(result) && !clashes(result))
        ?? null;
}
