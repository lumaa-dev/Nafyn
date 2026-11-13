// Which iTunes Search API result is the preview of a MusicBrainz recording. Pure: no Nitro auto-imports, so
// `tests/trackPreview.test.ts` runs under `bun test`.

import { matchKey } from "./soulseekText";
import { levenshteinRatio } from "./search/similarity";

/** One song of `itunes.apple.com/search|lookup` (only the fields used). */
export interface ITunesSong {
    wrapperType?: string,
    kind?: string,
    trackId?: number,
    trackName?: string,
    artistName?: string,
    trackTimeMillis?: number,
    previewUrl?: string,
    isStreamable?: boolean
}

export interface PreviewTarget {
    title: string,
    artist: string,
    /** seconds, 0 when MusicBrainz has none */
    duration: number
}

/** a version marker in an iTunes title that the requested one doesn't have makes it another recording */
const VERSION_WORDS = /\b(live|remix|acoustic|instrumental|karaoke|demo|sped up|slowed|nightcore|cover|edit|remaster(?:ed)?)\b/i;

const DURATION_TOLERANCE_S = 5;
const MIN_SIMILARITY = 0.8;

// "Song (feat. X)" and "Song" are the same song on iTunes, where featurings live in the title
function stripFeaturing(text: string): string {
    return text.replace(/\s*[([]\s*(feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, "").replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, "");
}

function comparable(text: string): string {
    return matchKey(stripFeaturing(text));
}

/** 0..1 when `song` is a preview of `target`, null when it is not the same song */
export function previewScore(song: ITunesSong, target: PreviewTarget): number | null {
    if (!song.previewUrl || !song.trackName || !song.artistName) return null;
    if (song.kind && song.kind !== "song") return null;

    const wantedTitle = comparable(target.title);
    const title = comparable(song.trackName);
    if (!wantedTitle || !title) return null;
    if (VERSION_WORDS.test(song.trackName) && !VERSION_WORDS.test(target.title)) return null;

    const titleSimilarity = title === wantedTitle ? 1 : levenshteinRatio(title, wantedTitle);
    if (titleSimilarity < MIN_SIMILARITY) return null;

    // "A & B" on iTunes, "A" on MusicBrainz (or the other way round): one credited name in the other is enough
    const wantedArtist = comparable(target.artist);
    const artist = comparable(song.artistName);
    const artistMatches = !wantedArtist || artist === wantedArtist || artist.includes(wantedArtist) || wantedArtist.includes(artist)
        || levenshteinRatio(artist, wantedArtist) >= MIN_SIMILARITY;
    if (!artistMatches) return null;

    let durationScore = 0.5;
    if (target.duration > 0 && song.trackTimeMillis) {
        const delta = Math.abs(song.trackTimeMillis / 1000 - target.duration);
        if (delta > DURATION_TOLERANCE_S) return null;
        durationScore = 1 - delta / (DURATION_TOLERANCE_S * 2);
    }

    return titleSimilarity * 0.6 + durationScore * 0.4;
}

/** the best preview among `songs`, or null */
export function pickPreview(songs: ITunesSong[], target: PreviewTarget): ITunesSong | null {
    let best: { song: ITunesSong, score: number } | null = null;
    for (const song of songs) {
        const score = previewScore(song, target);
        if (score === null) continue;
        if (!best || score > best.score) best = { song, score };
    }
    return best?.song ?? null;
}

/** previews are only ever fetched from Apple's own audio hosts */
export function isAllowedPreviewHost(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") return false;
        const host = parsed.hostname.toLowerCase();
        return host === "audio-ssl.itunes.apple.com" || host.endsWith(".itunes.apple.com") || host.endsWith(".mzstatic.com") || host.endsWith(".apple.com");
    } catch {
        return false;
    }
}
