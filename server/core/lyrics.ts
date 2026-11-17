// ---------------------------------------------------------------------------
// The lyrics of a track, as the lyrics routes answer them: the user-written ones first (`media_lyrics`), then the
// providers in order until one has a match, parsed by Braccato (`server/utils/lyrics/parse.ts`) and kept in the
// 20-minute lyrics cache (`server/utils/lyrics/cache.ts`) with the track's lyric offset.
// ---------------------------------------------------------------------------

import { fetchBetterLyrics, fetchBetterLyricsPortato } from "../utils/lyrics/betterlyrics";
import { cacheLyrics, getCachedLyrics, lyricsCacheKey, type LyricsAnswer } from "../utils/lyrics/cache";
import { fetchCiderLyrics } from "../utils/lyrics/cider";
import { fetchLrclib } from "../utils/lyrics/lrclib";
import type { TrackLookup } from "../utils/lyrics/match";
import { lyricsSyncType, parseLrc, parsePlain, type ParsedLyrics } from "../utils/lyrics/parse";
import { Provider } from "../utils/lyrics/provider";
import { fetchUnison, type UnisonCredit } from "../utils/lyrics/unison";
import { getMediaIsrcs, type MediaRow } from "./library";
import { getMediaLyrics } from "./mediaLyrics";

export interface TrackLyrics extends LyricsAnswer {
	/** Milliseconds the lyrics are shown later (negative: earlier) than their own timing says. */
	offsetMs: number;
}

interface LyricsProvider {
	provider: Provider;
	fetch: (lookup: TrackLookup, media: MediaRow) => Promise<(ParsedLyrics & { credit?: UnisonCredit }) | null>;
}

// in this order: the syllable-timed community providers first, then Portato (word-timed), then Cider (needs the
// track's catalogue id), then LRCLIB, which has the widest coverage but mostly line-timed lyrics
const LYRICS_PROVIDERS: LyricsProvider[] = [
	{ provider: Provider.Unison, fetch: (lookup) => fetchUnison(lookup) },
	{ provider: Provider.BetterLyrics, fetch: (lookup) => fetchBetterLyrics(lookup) },
	{ provider: Provider.BetterLyricsPortato, fetch: (lookup) => fetchBetterLyricsPortato(lookup) },
	{ provider: Provider.Cider, fetch: (lookup, media) => media.amId ? fetchCiderLyrics(media.amId, durationMsOf(lookup)) : Promise.resolve(null) },
	{ provider: Provider.Lrclib, fetch: (lookup) => fetchLrclib(lookup) },
];

const durationMsOf = (lookup: TrackLookup) => lookup.duration ? lookup.duration * 1000 : undefined;

function lookupOf(media: MediaRow, isrcs: string[]): TrackLookup {
	return {
		trackName: media.title,
		artistName: media.artistName,
		albumName: media.album ?? undefined,
		// a recording can carry several ISRCs; the first is enough to name it (a wrong one simply finds nothing
		// and the title + artist lookup follows)
		isrc: isrcs[0],
		duration: media.duration || undefined,
	};
}

function answerOf(provider: Provider, found: ParsedLyrics & { credit?: UnisonCredit }): LyricsAnswer {
	const answer: LyricsAnswer = { provider, syncType: lyricsSyncType(found.lyrics), lyrics: found.lyrics, songwriters: found.songwriters };
	if (found.language) answer.language = found.language;
	if (found.credit) answer.credit = found.credit;
	return answer;
}

async function findLyrics(media: MediaRow, isrcs: string[]): Promise<LyricsAnswer | null> {
	const lookup = lookupOf(media, isrcs);

	// user-supplied lyrics win over every fetched provider: someone typed them in for this exact track, and for a
	// manually imported one no provider can know about it at all
	const manual = await getMediaLyrics(media.id);
	if (manual) {
		const parsed = manual.format === "lrc" ? parseLrc(manual.content, durationMsOf(lookup)) : parsePlain(manual.content);
		if (parsed) return answerOf(Provider.Manual, parsed);
	}

	for (const { provider, fetch } of LYRICS_PROVIDERS) {
		const found = await fetch(lookup, media);
		if (found) {
			console.log(`[lyrics] ${media.id}: lyrics from ${provider}`);
			return answerOf(provider, found);
		}
	}
	return null;
}

const inFlight = new Map<string, Promise<TrackLyrics | null>>();

async function keyOf(media: MediaRow): Promise<string> {
	const isrcs = await getMediaIsrcs(media.id);
	return lyricsCacheKey({ mediaId: media.id, title: media.title, artist: media.artistName, album: media.album, duration: media.duration, amId: media.amId, isrcs });
}

/** The track's lyrics with their offset, or `null` when nobody has any. Cached for 20 minutes, found or not. */
export async function getTrackLyrics(media: MediaRow): Promise<TrackLyrics | null> {
	const key = await keyOf(media);
	const cached = getCachedLyrics(key);
	if (cached) return cached.answer ? { ...cached.answer, offsetMs: cached.offsetMs } : null;

	// two players asking for the same track at once share one round of provider calls
	let running = inFlight.get(key);
	if (!running) {
		running = (async () => {
			const answer = await findLyrics(media, await getMediaIsrcs(media.id));
			cacheLyrics(key, media.id, answer);
			return answer ? { ...answer, offsetMs: 0 } : null;
		})().finally(() => inFlight.delete(key));
		inFlight.set(key, running);
	}
	return running;
}

/** The cache key of a track's lyrics, for the offset route (which first makes sure they are cached). */
export function trackLyricsKey(media: MediaRow): Promise<string> {
	return keyOf(media);
}
