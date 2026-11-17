// ---------------------------------------------------------------------------
// The lyrics cache: what was found for a track (or that nothing was), kept for 20 minutes, together with the
// track's lyric offset.
//
// Replaying (or merely loading the Now Playing page of) a track asks no provider again; "nothing found" is kept
// as long, so a song no provider has costs one round of calls per 20 minutes, not one per play. The key carries
// what the providers are asked (title, artist, album, length, catalogue id, ISRCs), so an edit of the track's
// metadata is never answered with lyrics fetched for the old one. Capped, oldest first.
//
// The offset lives in the same entry, on purpose: it corrects THESE lyrics against the track's (shared) audio
// file, for everyone who can play it, and goes when they go - a new fetch after expiry, an edit of the
// user-written lyrics or of the metadata starts from 0 again. Pure, in-memory, per process (like the rest of
// the lyrics route).
// ---------------------------------------------------------------------------

import type { Lyric, LyricSyncType } from "./parse";
import type { Provider } from "./provider";
import type { UnisonCredit } from "./unison";

export const LYRICS_CACHE_TTL_MS = 20 * 60 * 1000;
export const MAX_CACHED_TRACKS = 500;
/** How far the lyrics can be moved either way, in milliseconds. */
export const MAX_LYRICS_OFFSET_MS = 30_000;

/** What the lyrics route answers (minus the offset, which is read from the entry). */
export interface LyricsAnswer {
	provider: Provider;
	syncType: LyricSyncType;
	lyrics: Lyric[];
	songwriters: string[];
	language?: string;
	/** Only set by providers whose licence asks for one (Unison). */
	credit?: UnisonCredit;
}

interface Entry {
	mediaId: string;
	answer: LyricsAnswer | null;
	expiresAtMs: number;
	offsetMs: number;
}

const entries = new Map<string, Entry>();

export function lyricsCacheKey(parts: { mediaId: string; title: string; artist: string; album?: string | null; duration?: number | null; amId?: string | null; isrcs: string[] }): string {
	return [parts.mediaId, parts.title, parts.artist, parts.album ?? "", parts.duration ?? "", parts.amId ?? "", parts.isrcs.join(",")].join("\u0000");
}

function live(key: string, now: number): Entry | undefined {
	const entry = entries.get(key);
	if (!entry) return undefined;
	if (entry.expiresAtMs > now) return entry;
	entries.delete(key);
	return undefined;
}

/** The cached answer (`null` = nothing found) and offset, or `undefined` when the key has nothing live. */
export function getCachedLyrics(key: string, now = Date.now()): { answer: LyricsAnswer | null; offsetMs: number } | undefined {
	const entry = live(key, now);
	return entry ? { answer: entry.answer, offsetMs: entry.offsetMs } : undefined;
}

/** Stores an answer for 20 minutes; a new answer starts with no offset. */
export function cacheLyrics(key: string, mediaId: string, answer: LyricsAnswer | null, now = Date.now()): void {
	entries.delete(key);
	if (entries.size >= MAX_CACHED_TRACKS) entries.delete(entries.keys().next().value!);
	entries.set(key, { mediaId, answer, expiresAtMs: now + LYRICS_CACHE_TTL_MS, offsetMs: 0 });
}

/** Rounds to whole milliseconds and keeps it within +-30 s. */
export function clampLyricsOffset(offsetMs: number): number {
	return Math.max(-MAX_LYRICS_OFFSET_MS, Math.min(MAX_LYRICS_OFFSET_MS, Math.round(offsetMs)));
}

/**
 * Sets the offset of the lyrics cached under `key`. `false` when nothing (or "no lyrics") is cached there: an
 * offset only means something next to the lyrics it moves.
 */
export function setCachedLyricsOffset(key: string, offsetMs: number, now = Date.now()): boolean {
	const entry = live(key, now);
	if (!entry?.answer || entry.answer.syncType === "none") return false;
	entry.offsetMs = clampLyricsOffset(offsetMs);
	return true;
}

/** Drops everything cached for a track (its user-written lyrics changed). */
export function forgetCachedLyrics(mediaId: string): void {
	for (const [key, entry] of entries) {
		if (entry.mediaId === mediaId) entries.delete(key);
	}
}

/** Tests only. */
export function clearLyricsCache(): void {
	entries.clear();
}
