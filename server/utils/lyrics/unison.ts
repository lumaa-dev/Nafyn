// ---------------------------------------------------------------------------
// Unison client (https://unison.betterlyrics.org, crowdsourced lyrics behind Better Lyrics)
//
// Reads need no key. `GET /lyrics` answers `{ success, data }` with the top-ranked entry, found by `isrc`, or by
// `song` + `artist` (+ `album`, `duration` in seconds, +-2 s). The `v` (YouTube video id) and the Spotify / Apple
// Music / Tidal id lookups are not used on purpose: they name YouTube Music or third-party catalogues, which
// Nafyn knows nothing about (and must not start to).
//
// Unison hands back "the best" of whatever matched, so what comes back is checked again here (title, artist,
// length) before being trusted. Data is under the Unison Community License 1.0 (people, non-profits and
// open-source projects only - Nafyn is open source and lyrics stay free to every user): the lyrics must be
// credited to Unison and to their submitter (`UnisonCredit`, deadline 7 February 2027), and are never sold or
// put behind a paywall.
// ---------------------------------------------------------------------------

import { parseLrcSyncedLyrics } from "./lrclib";
import { parseQRC, TTMLParser, type LyricParagraphs } from "./parser";
import { LYRICS_DURATION_TOLERANCE_SECONDS, lyricsFitDuration, sameTrackByName, type TrackLookup } from "./match";

const UNISON_BASE_URL = "https://unison.betterlyrics.org";
const USER_AGENT = "Nafyn (https://github.com/lumaa-dev/Nafyn)";

interface UnisonLyrics {
	id?: number;
	videoId?: string;
	song?: string;
	artist?: string;
	album?: string;
	isrc?: string;
	duration?: number;
	format?: string;
	syncType?: string;
	lyrics?: string;
	/** How the entry was found; absent on a `v` lookup. */
	matchedBy?: "isrc" | "song_artist" | "linked_video";
	submitter?: { displayName?: string; keyId?: string } | null;
}

/** What Unison's licence asks to be shown with its lyrics ("Lyrics from Unison" + the person who submitted them). */
export interface UnisonCredit {
	/** `Lyrics from Unison`. */
	text: string;
	/** Unison's page for this song (the place to vote, report or fix a wrong line). */
	url: string;
	submitter: { name: string; url: string } | null;
}

export interface UnisonResult {
	paragraphs: LyricParagraphs;
	credit: UnisonCredit;
}

/** An ISRC is 12 letters/digits; Unison accepts any case and optional hyphens. */
function normalizeIsrc(isrc: string | undefined): string | null {
	const value = isrc?.replace(/-/g, "").toUpperCase();
	return value && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value) ? value : null;
}

async function unisonGet(params: Record<string, string>): Promise<UnisonLyrics | null> {
	const url = new URL(`${UNISON_BASE_URL}/lyrics`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

	const response = await fetch(url, {
		method: "GET",
		headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
		cache: "no-store",
		signal: AbortSignal.timeout(8_000),
	});
	// 404 = nothing for this song, 429 RATE_LIMITED = over the per-IP read limit
	if (!response.ok) return null;

	const json = await response.json() as { success?: boolean; data?: UnisonLyrics };
	return json?.success && json.data && typeof json.data === "object" ? json.data : null;
}

/** By ISRC when the track has one (that names the recording), otherwise by title + artist. */
async function unisonLookup(lookup: TrackLookup): Promise<UnisonLyrics | null> {
	const isrc = normalizeIsrc(lookup.isrc);
	if (isrc) {
		const byIsrc = await unisonGet({ isrc });
		if (byIsrc) return byIsrc;
	}

	// without a length, "the best match" can be any recording of that title
	if (!lookup.duration || lookup.duration <= 0) return null;

	const params: Record<string, string> = {
		song: lookup.trackName,
		artist: lookup.artistName,
		duration: String(Math.round(lookup.duration)),
	};
	if (lookup.albumName) params.album = lookup.albumName;
	return unisonGet(params);
}

function parseEntry(entry: UnisonLyrics, lookup: TrackLookup): LyricParagraphs | null {
	const body = entry.lyrics;
	if (!body) return null;

	switch (entry.format) {
		case "ttml":
			return new TTMLParser(body).parse();
		case "lrc":
			return parseLrcSyncedLyrics(body);
		// `qrc` is no longer listed by Unison (ttml / lrc / plain) but older entries may still carry it
		case "qrc":
			return parseQRC(body, { title: lookup.trackName, artist: lookup.artistName, durationMs: lookup.duration ? lookup.duration * 1000 : undefined });
		// unsynced text: LRCLIB, later in line, may have a synced version of the same song
		default:
			return null;
	}
}

function creditOf(entry: UnisonLyrics): UnisonCredit {
	const name = entry.submitter?.displayName?.trim();
	const keyId = entry.submitter?.keyId?.trim();
	return {
		text: "Lyrics from Unison",
		url: entry.videoId ? `${UNISON_BASE_URL}/song/${encodeURIComponent(entry.videoId)}` : UNISON_BASE_URL,
		submitter: name ? { name, url: keyId ? `${UNISON_BASE_URL}/curator/${encodeURIComponent(keyId)}` : UNISON_BASE_URL } : null,
	};
}

/** Community lyrics from Unison for exactly this song, with the credit to show, or `null`. */
export async function fetchUnison(lookup: TrackLookup): Promise<UnisonResult | null> {
	try {
		const entry = await unisonLookup(lookup);
		if (!entry) return null;

		// the YouTube video BiniLink links to an ISRC can be another release, so its timing may drift
		if (entry.matchedBy === "linked_video") return null;

		// an ISRC names the recording, so only a title + artist match has to agree on the names
		if (entry.matchedBy !== "isrc" && !sameTrackByName(lookup, entry)) return null;
		// the entry's own length, when it states one and we know ours
		if (lookup.duration && typeof entry.duration === "number" && Math.abs(entry.duration - lookup.duration) > LYRICS_DURATION_TOLERANCE_SECONDS) return null;

		const paragraphs = parseEntry(entry, lookup);
		if (!paragraphs || paragraphs.length === 0) return null;
		if (!lyricsFitDuration(paragraphs, lookup.duration)) return null;

		return { paragraphs, credit: creditOf(entry) };
	} catch (e) {
		console.error("[Unison] fetch failed:", e);
		return null;
	}
}

/** Community lyrics from Unison for exactly this song, or `null`. Use {@link fetchUnison} to get the credit too. */
export async function fetchUnisonParagraphs(lookup: TrackLookup): Promise<LyricParagraphs | null> {
	return (await fetchUnison(lookup))?.paragraphs ?? null;
}
