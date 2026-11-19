// Shared shapes of the mixes engine. Everything is keyed by string: a library track is its media id, a
// catalog suggestion is "rec:<recording MBID>".
import type { AudioFeatures } from "./audio";

export interface TrackInfo {
    key: string,
    recordingId: string | null,
    title: string,
    artists: string[],
    /** primary artist identity: MBID when known, else the lowercased name */
    artistKey: string,
    album: string | null,
    albumId: string | null,
    releaseYear: number | null,
    /** ms since the epoch */
    releasedAt: number | null,
    durationMs: number | null,
    /** MusicBrainz genres (most voted first), lowercased */
    genres: string[],
    audio: AudioFeatures | null,
    /** the mood an editor gave the album or artist (TheAudioDB), used when no audio could be measured */
    tagMood?: Mood | null,
    /** the editor's genre / style / mood words (TheAudioDB), compared as text */
    tags?: string[],
    owned: boolean
}

export type EngagementKind = "stream" | "skip" | "save" | "playlist_add";

export interface Engagement {
    trackKey: string,
    kind: EngagementKind,
    /** ms since the epoch */
    at: number,
    msPlayed?: number,
    /** local hour of the event, 0-23, when known */
    localHour?: number
}

export const TIME_BINS = ["night", "morning", "afternoon", "evening"] as const;
export type TimeBin = (typeof TIME_BINS)[number];

export function timeBin(hour: number): TimeBin {
    if (hour < 6) return "night";
    if (hour < 12) return "morning";
    if (hour < 18) return "afternoon";
    return "evening";
}

export const MOODS = ["upbeat", "intense", "mellow", "melancholic"] as const;
export type Mood = (typeof MOODS)[number];

/**
 * quadrant of the (estimated) energy x valence plane. Measured audio wins; without it, the mood an editor tagged
 * the album or artist with (TheAudioDB, already mapped to a quadrant), if any.
 */
export function moodOf(audio: AudioFeatures | null, tagged: Mood | null = null): Mood | null {
    if (!audio) return tagged;
    const high = audio.energy >= 0.55;
    const positive = audio.valence >= 0.5;
    if (high) return positive ? "upbeat" : "intense";
    return positive ? "mellow" : "melancholic";
}

export function decadeOf(year: number | null): string | null {
    if (!year || year < 1900) return null;
    return `${Math.floor(year / 10) * 10}s`;
}

export type LabelKind = "genre" | "decade" | "mood" | "time" | "artist";

/** what a mix is about - structured, so each client writes the title in its own language */
export interface MixLabel {
    kind: LabelKind,
    /** genre / "1990s" / mood id / time bin / artist names joined by ", " */
    value: string,
    qualifier?: { kind: LabelKind, value: string }
}

/** English title, for clients that do not localize */
export function fallbackTitle(label: MixLabel): string {
    const cap = (s: string) => s.replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
    const part = (kind: LabelKind, value: string) => {
        switch (kind) {
            case "genre": return cap(value);
            case "decade": return value;
            case "mood": return cap(value);
            case "time": return { night: "Late Night", morning: "Morning", afternoon: "Afternoon", evening: "Evening" }[value as TimeBin] ?? cap(value);
            case "artist": return value;
        }
    };
    const main = label.kind === "artist" ? `${label.value} and more` : `${part(label.kind, label.value)} Mix`;
    return label.qualifier ? `${main} · ${part(label.qualifier.kind, label.qualifier.value)}` : main;
}
