// ---------------------------------------------------------------------------
// Better Lyrics client (https://docs.betterlyrics.org/)
//
// `GET /getLyrics?s=&a=&al=&d=` answers `{ ttml, score? }` (word-timed TTML); `GET /qq/getLyrics` the QQ
// provider's `{ lyrics }` (QRC, word-timed too). They no longer hand out API keys: a song is only served once
// someone has cached it through Unison or the Better Lyrics extension, an uncached one answers 401 - which is
// simply "no lyrics here", not an error. All four parameters are sent because the cache key includes album and
// duration.
// ---------------------------------------------------------------------------

import { parseQRC, qrcHeader, TTMLParser, type LyricParagraphs } from "./parser";
import { artistsShare, lyricsFitDuration, titleKey, type TrackLookup } from "./match";

const BETTER_LYRICS_BASE_URL = "https://api.betterlyrics.org";
const USER_AGENT = "Nafyn (https://github.com/lumaa-dev/Nafyn)";

/** `score` (0-1) is only sent for a freshly fetched song; below this it is another song's lyrics. */
const MIN_SCORE = 0.7;

async function betterLyricsJson(path: string, lookup: TrackLookup): Promise<Record<string, unknown> | null> {
	const url = new URL(`${BETTER_LYRICS_BASE_URL}${path}`);
	url.searchParams.set("s", lookup.trackName);
	url.searchParams.set("a", lookup.artistName);
	if (lookup.albumName) url.searchParams.set("al", lookup.albumName);
	if (lookup.duration) url.searchParams.set("d", String(Math.round(lookup.duration)));

	const response = await fetch(url, {
		method: "GET",
		headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
		cache: "no-store",
		// a stalled provider must not pin the request (and the player waiting on lyrics) open
		signal: AbortSignal.timeout(8_000),
	});
	// 401 = not cached yet, 404/422 = unknown or unusable query, 429 = rate limited: none of them is lyrics
	if (!response.ok) return null;

	const json = await response.json();
	return json && typeof json === "object" ? json as Record<string, unknown> : null;
}

async function fetchTtml(lookup: TrackLookup): Promise<LyricParagraphs | null> {
	const json = await betterLyricsJson("/getLyrics", lookup);
	if (!json || typeof json.ttml !== "string" || json.ttml.length === 0) return null;
	if (typeof json.score === "number" && json.score < MIN_SCORE) return null;

	const paragraphs = new TTMLParser(json.ttml).parse();
	if (!paragraphs || paragraphs.length === 0) return null;
	return lyricsFitDuration(paragraphs, lookup.duration) ? paragraphs : null;
}

async function fetchQrc(lookup: TrackLookup): Promise<LyricParagraphs | null> {
	const json = await betterLyricsJson("/qq/getLyrics", lookup);
	if (!json || typeof json.lyrics !== "string" || json.lyrics.length === 0) return null;

	// QRC names its song in the header tags, so unlike the TTML it can be checked against what was asked for
	const header = qrcHeader(json.lyrics);
	if (header.title && titleKey(header.title) !== titleKey(lookup.trackName)) return null;
	if (header.artist && !artistsShare(header.artist, lookup.artistName)) return null;

	const paragraphs = parseQRC(json.lyrics, {
		title: header.title ?? lookup.trackName,
		artist: header.artist ?? lookup.artistName,
		durationMs: lookup.duration ? lookup.duration * 1000 : undefined,
	});
	if (!paragraphs || paragraphs.length === 0) return null;
	return lyricsFitDuration(paragraphs, lookup.duration) ? paragraphs : null;
}

/** Word-timed lyrics from Better Lyrics (TTML first, then the QQ provider's QRC), or `null`. */
export async function fetchBetterLyricsParagraphs(lookup: TrackLookup): Promise<LyricParagraphs | null> {
	// the cache key is song + artist + album + duration: without a length no entry can be told from a cover's
	if (!lookup.duration || lookup.duration <= 0) return null;

	for (const fetchOne of [fetchTtml, fetchQrc]) {
		try {
			const paragraphs = await fetchOne(lookup);
			if (paragraphs) return paragraphs;
		} catch (e) {
			console.error("[BetterLyrics] fetch failed:", e);
		}
	}
	return null;
}
