// What TheAudioDB says an artist or an album sounds like - its genre, style and mood ("Rock", "Psychedelic Rock",
// "Reflective") - for the recommendations (server/core/recAudioDb.ts). Pure, no Nitro auto-imports, so it runs
// under `bun test`.
//
// The answers are free text typed by TheAudioDB's editors, so they are normalized (trimmed, lowercased, empty and
// placeholder values dropped) and an album's are completed by its artist's, field by field.
import type { Mood } from "./recommender/mixes/types";

export interface AudioDbTags {
    genre: string | null,
    style: string | null,
    mood: string | null
}

export const NO_TAGS: AudioDbTags = Object.freeze({ genre: null, style: null, mood: null });

// TheAudioDB's editors leave these in for "nobody filled it in"
const PLACEHOLDERS = new Set(["", "...", "-", "n/a", "na", "none", "null", "unknown", "other", "misc"]);

function tag(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    if (PLACEHOLDERS.has(cleaned) || cleaned.length > 60) return null;
    return cleaned;
}

/** The genre / style / mood of one `artists[]` or `album[]` entry of a TheAudioDB answer. */
export function audioDbTagsOf(entry: Record<string, unknown> | null | undefined): AudioDbTags {
    if (!entry || typeof entry !== "object") return NO_TAGS;
    return { genre: tag(entry.strGenre), style: tag(entry.strStyle), mood: tag(entry.strMood) };
}

/**
 * An `album-mb.php?i=<release-group MBID>` answer -> that album's tags. null when TheAudioDB doesn't know the album
 * (`album` is null); an album it maps to another MusicBrainz release-group is skipped.
 */
export function audioDbAlbumTags(body: unknown, releaseGroupId: string): AudioDbTags | null {
    const albums = (body as { album?: Array<Record<string, unknown>> | null } | null)?.album;
    if (!Array.isArray(albums)) return null;
    for (const album of albums) {
        if (!album || typeof album !== "object") continue;
        const theirs = typeof album.strMusicBrainzID === "string" ? album.strMusicBrainzID.toLowerCase() : null;
        if (theirs && theirs !== releaseGroupId.toLowerCase()) continue;
        return audioDbTagsOf(album);
    }
    return null;
}

/** The album's own tags, each missing one taken from the artist's. */
export function mergeTags(album: AudioDbTags | null | undefined, artist: AudioDbTags | null | undefined): AudioDbTags {
    return {
        genre: album?.genre ?? artist?.genre ?? null,
        style: album?.style ?? artist?.style ?? null,
        mood: album?.mood ?? artist?.mood ?? null
    };
}

export function hasTags(tags: AudioDbTags | null | undefined): tags is AudioDbTags {
    return !!tags && (tags.genre !== null || tags.style !== null || tags.mood !== null);
}

/** Genre then style, deduplicated: what a track is filed under when MusicBrainz has no genre for it. */
export function tagGenres(tags: AudioDbTags | null | undefined): string[] {
    if (!tags) return [];
    return [...new Set([tags.genre, tags.style].filter((value): value is string => value !== null))];
}

/** Every word worth comparing (genre, style and mood), for the text profile of a track. */
export function tagWords(tags: AudioDbTags | null | undefined): string[] {
    if (!tags) return [];
    return [tags.genre, tags.style, tags.mood].filter((value): value is string => value !== null);
}

// TheAudioDB's moods, on the four quadrants of the energy x valence plane the mixes use (`moodOf` in
// recommender/mixes/types.ts). A mood not listed says nothing about either axis and maps to nothing.
const MOOD_QUADRANTS: Record<Mood, readonly string[]> = {
    upbeat: ["happy", "uplifting", "energetic", "excited", "exciting", "fun", "party", "joyful", "joyous", "cheerful", "euphoric", "playful", "positive", "carefree", "groovy", "celebratory"],
    intense: ["angry", "aggressive", "intense", "dark", "powerful", "rebellious", "tense", "epic", "furious", "brooding", "menacing", "anxious", "hostile"],
    mellow: ["relaxed", "relaxing", "calm", "chilled", "chill", "mellow", "dreamy", "romantic", "sensual", "peaceful", "soothing", "cool", "sophisticated", "hypnotic", "laid back", "laid-back", "smooth", "warm", "tender", "gentle"],
    melancholic: ["sad", "melancholy", "melancholic", "reflective", "sombre", "somber", "gloomy", "lonely", "bittersweet", "nostalgic", "emotional", "longing", "wistful", "mournful", "depressing", "haunting"]
};

const QUADRANT_OF = new Map<string, Mood>(
    (Object.entries(MOOD_QUADRANTS) as [Mood, readonly string[]][]).flatMap(([mood, words]) => words.map((word) => [word, mood] as const))
);

/** The mixes' mood for TheAudioDB's, or null when it names none of the four. */
export function moodFromTag(mood: string | null | undefined): Mood | null {
    if (!mood) return null;
    const cleaned = tag(mood);
    return cleaned ? QUADRANT_OF.get(cleaned) ?? null : null;
}
