// ---------------------------------------------------------------------------
// LRCLIB client (https://lrclib.net/docs)
//
// Unlike Cider, LRCLIB has no catalogue id —
// tracks are looked up by title/artist/(album)/(duration) instead. This
// module only implements fetching, not `/api/publish` (submitting lyrics).
// ---------------------------------------------------------------------------

import { parseLrc, parsePlain, type ParsedLyrics } from "./parse";

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
		// a stalled provider must not pin the request (and the player waiting on lyrics) open
		signal: AbortSignal.timeout(8_000),
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

/** Resolves a title/artist(/album/duration) to lyrics via LRCLIB (synced first, else plain), or `null`. */
export async function fetchLrclib(
	lookup: LrclibLookup,
): Promise<ParsedLyrics | null> {
	const track = await fetchLrclibTrack(lookup);
	if (!track || track.instrumental) return null;

	const durationMs = lookup.duration ? lookup.duration * 1000 : undefined;
	if (track.syncedLyrics) {
		const synced = parseLrc(track.syncedLyrics, durationMs);
		if (synced) return synced;
	}
	if (track.plainLyrics) return parsePlain(track.plainLyrics);
	return null;
}
