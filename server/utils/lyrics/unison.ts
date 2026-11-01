// ---------------------------------------------------------------------------
// Unison client (https://unison.boidu.dev, crowdsourced lyrics behind Better Lyrics)
//
// Reads need no key: `GET /lyrics?song=&artist=&album=&duration=` answers `{ success, data }` with the
// best-scored entry. Unison matches the title exactly and the artist when one whole credited name is shared,
// and `duration` (seconds) narrows it to +-2 s - but it hands back "the best" of whatever matched, so what
// comes back is checked again here (title, artist, length) before being trusted.
// ---------------------------------------------------------------------------

import { parseLrcSyncedLyrics } from "./lrclib";
import { parseQRC, TTMLParser, type LyricParagraphs } from "./parser";
import { LYRICS_DURATION_TOLERANCE_SECONDS, lyricsFitDuration, sameTrackByName, type TrackLookup } from "./match";

const UNISON_BASE_URL = "https://unison.boidu.dev";
const USER_AGENT = "Nafyn (https://github.com/lumaa-dev/Nafyn)";

interface UnisonLyrics {
	song?: string;
	artist?: string;
	album?: string;
	duration?: number;
	format?: string;
	syncType?: string;
	lyrics?: string;
}

async function unisonLookup(lookup: TrackLookup): Promise<UnisonLyrics | null> {
	const url = new URL(`${UNISON_BASE_URL}/lyrics`);
	url.searchParams.set("song", lookup.trackName);
	url.searchParams.set("artist", lookup.artistName);
	if (lookup.albumName) url.searchParams.set("album", lookup.albumName);
	if (lookup.duration) url.searchParams.set("duration", String(Math.round(lookup.duration)));

	const response = await fetch(url, {
		method: "GET",
		headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
		cache: "no-store",
		signal: AbortSignal.timeout(8_000),
	});
	// 404 NOT_FOUND = nothing for this song, 429 = rate limited (120/min/IP)
	if (!response.ok) return null;

	const json = await response.json() as { success?: boolean; data?: UnisonLyrics };
	return json?.success && json.data && typeof json.data === "object" ? json.data : null;
}

function parseEntry(entry: UnisonLyrics, lookup: TrackLookup): LyricParagraphs | null {
	const body = entry.lyrics;
	if (!body) return null;

	switch (entry.format) {
		case "ttml":
			return new TTMLParser(body).parse();
		case "lrc":
			return parseLrcSyncedLyrics(body);
		case "qrc":
			return parseQRC(body, { title: lookup.trackName, artist: lookup.artistName, durationMs: lookup.duration ? lookup.duration * 1000 : undefined });
		// unsynced text: LRCLIB, later in line, may have a synced version of the same song
		default:
			return null;
	}
}

/** Community lyrics from Unison for exactly this song, or `null`. */
export async function fetchUnisonParagraphs(lookup: TrackLookup): Promise<LyricParagraphs | null> {
	// without a length, "the best match" can be any recording of that title
	if (!lookup.duration || lookup.duration <= 0) return null;

	try {
		const entry = await unisonLookup(lookup);
		if (!entry) return null;

		if (!sameTrackByName(lookup, entry)) return null;
		// the entry's own length, when it states one (the +-2 s filter was already applied by Unison)
		if (typeof entry.duration === "number" && Math.abs(entry.duration - lookup.duration) > LYRICS_DURATION_TOLERANCE_SECONDS) return null;

		const paragraphs = parseEntry(entry, lookup);
		if (!paragraphs || paragraphs.length === 0) return null;
		return lyricsFitDuration(paragraphs, lookup.duration) ? paragraphs : null;
	} catch (e) {
		console.error("[Unison] fetch failed:", e);
		return null;
	}
}
