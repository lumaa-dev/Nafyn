// ---------------------------------------------------------------------------
// LRCLIB client (https://lrclib.net/docs)
//
// Unlike Apple Music / Cider, LRCLIB has no concept of an Apple Music id —
// tracks are looked up by title/artist/(album)/(duration) instead. This
// module only implements fetching, not `/api/publish` (submitting lyrics).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { createLyricLine, type LyricParagraphs } from "./parser";

const LRCLIB_BASE_URL = "https://lrclib.net/api";

// LRCLIB asks API consumers to identify themselves via User-Agent.
const USER_AGENT = "Nafyn (https://github.com/lumaa-dev/Nafyn)";

/** A single track+lyrics record as returned by `/api/get` and `/api/search`. */
export interface LrclibTrack {
	id: number;
	trackName: string;
	artistName: string;
	albumName: string | null;
	duration: number | null;
	instrumental: boolean;
	plainLyrics: string | null;
	syncedLyrics: string | null;
}

export interface LrclibLookup {
	trackName: string;
	artistName: string;
	albumName?: string;
	/** Track duration in seconds; LRCLIB uses this to disambiguate identical titles. */
	duration?: number;
}

async function lrclibFetch(
	path: string,
	params: Record<string, string | number | undefined>,
): Promise<Response> {
	const url = new URL(`${LRCLIB_BASE_URL}${path}`);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}

	return fetch(url, {
		method: "GET",
		headers: { "User-Agent": USER_AGENT },
		cache: "no-store",
	});
}

/**
 * Exact lookup via `GET /api/get` — matches on track/artist/(album)/(duration).
 * Returns `null` on a 404 (no match), not just on network/decode failure.
 */
async function getExact(lookup: LrclibLookup): Promise<LrclibTrack | null> {
	const response = await lrclibFetch("/get", {
		track_name: lookup.trackName,
		artist_name: lookup.artistName,
		album_name: lookup.albumName,
		duration: lookup.duration,
	});

	if (!response.ok) return null;

	return (await response.json()) as LrclibTrack;
}

/**
 * Fallback fuzzy lookup via `GET /api/search`, used when the exact match
 * fails (e.g. slightly different album title). Picks the best-scoring
 * result whose artist matches (case-insensitively); prefers synced lyrics
 * and, among ties, the closest duration.
 */
async function searchBest(lookup: LrclibLookup): Promise<LrclibTrack | null> {
	const response = await lrclibFetch("/search", {
		track_name: lookup.trackName,
		artist_name: lookup.artistName,
	});

	if (!response.ok) return null;

	const results = (await response.json()) as LrclibTrack[];
	const artistLower = lookup.artistName.trim().toLowerCase();
	const candidates = results.filter(
		(r) => r.artistName.trim().toLowerCase() === artistLower,
	);
	if (candidates.length === 0) return null;

	candidates.sort((a, b) => {
		if (a.syncedLyrics && !b.syncedLyrics) return -1;
		if (!a.syncedLyrics && b.syncedLyrics) return 1;

		if (lookup.duration !== undefined) {
			const da = a.duration !== null ? Math.abs(a.duration - lookup.duration) : Infinity;
			const db = b.duration !== null ? Math.abs(b.duration - lookup.duration) : Infinity;
			return da - db;
		}

		return 0;
	});

	return candidates[0] ?? null;
}

/** Fetches the best-matching LRCLIB track for a title/artist(/album/duration), or `null`. */
export async function fetchLrclibTrack(
	lookup: LrclibLookup,
): Promise<LrclibTrack | null> {
	try {
		const exact = await getExact(lookup);
		if (exact) return exact;
		return await searchBest(lookup);
	} catch (e) {
		console.error("[LRCLIB] fetch failed:", e);
		return null;
	}
}

const LRC_TIMESTAMP_RE = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

/**
 * Parses LRCLIB's `syncedLyrics` (standard LRC: `[mm:ss.xx]text`, possibly
 * several timestamps sharing one line) into `LyricParagraphs`. LRC has no
 * word-level timing, so every line becomes a single un-segmented "main"
 * line; a blank-text timestamp is treated as a paragraph break.
 */
export function parseLrcSyncedLyrics(syncedLyrics: string): LyricParagraphs {
	const entries: { time: number; text: string }[] = [];

	for (const rawLine of syncedLyrics.split(/\r?\n/)) {
		LRC_TIMESTAMP_RE.lastIndex = 0;
		const tags = [...rawLine.matchAll(LRC_TIMESTAMP_RE)];
		if (tags.length === 0) continue;

		const text = rawLine.replace(LRC_TIMESTAMP_RE, "").trim();
		for (const tag of tags) {
			const minutes = Number(tag[1]);
			const seconds = Number(tag[2]);
			const millis = tag[3] ? Number(tag[3].padEnd(3, "0")) : 0;
			entries.push({ time: minutes * 60 + seconds + millis / 1000, text });
		}
	}

	entries.sort((a, b) => a.time - b.time);

	const paragraphs: LyricParagraphs = [];
	let currentLines: LyricParagraphs[number]["lines"] = [];

	const flush = () => {
		if (currentLines.length > 0) {
			paragraphs.push({ id: randomUUID(), lines: currentLines });
			currentLines = [];
		}
	};

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const next = entries[i + 1];
		const end = next ? next.time : entry.time + 5;

		if (entry.text.length === 0) {
			flush();
			continue;
		}

		currentLines.push(
			createLyricLine(entry.text, entry.time, end, { kind: "main", alt: false }),
		);
	}
	flush();

	return paragraphs;
}

/** Wraps `plainLyrics` (no timing at all) into a single static paragraph. */
export function parsePlainLyrics(plainLyrics: string): LyricParagraphs {
	const lines = plainLyrics
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => createLyricLine(line.trim(), 0, 0, { kind: "main", alt: false }));

	if (lines.length === 0) return [];
	return [{ id: randomUUID(), lines }];
}

/** Resolves a title/artist(/album/duration) to `LyricParagraphs` via LRCLIB, or `null`. */
export async function fetchLrclibParagraphs(
	lookup: LrclibLookup,
): Promise<LyricParagraphs | null> {
	const track = await fetchLrclibTrack(lookup);
	if (!track || track.instrumental) return null;

	if (track.syncedLyrics) return parseLrcSyncedLyrics(track.syncedLyrics);
	if (track.plainLyrics) return parsePlainLyrics(track.plainLyrics);
	return null;
}
