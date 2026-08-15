import {
	NafynLyrics,
	Provider,
	type LyricParagraphs,
} from "~~/server/utils/lyrics/parser";
import { fetchLrclibParagraphs } from "~~/server/utils/lyrics/lrclib";
import { getMediaId, type MediaRow } from "~~/server/core/library";

const lyricsService = new NafynLyrics();

interface LyricsProvider {
	provider: Provider;
	fetch: (media: MediaRow) => Promise<LyricParagraphs | null>;
}

function fetchLrclibByMedia(media: MediaRow): Promise<LyricParagraphs | null> {
	return fetchLrclibParagraphs({
		trackName: media.title,
		artistName: media.artistName,
		albumName: media.album ?? undefined,
		duration: media.duration || undefined,
	});
}

const LYRICS_PROVIDERS: LyricsProvider[] = [
	// {
	// 	provider: Provider.AppleMusic,
	// 	fetch: (media) => media.amId ? lyricsService.fetchAppleMusicParagraphs(media.amId) : Promise.resolve(null),
	// },
	{
		provider: Provider.Cider,
		fetch: (media) => media.amId ? lyricsService.fetchCiderParagraphs(media.amId) : Promise.resolve(null),
	},
	{
		provider: Provider.Lrclib,
		fetch: (media) => fetchLrclibByMedia(media),
	},
];

export default defineEventHandler(async (event) => {
	requireAuthToken(event);

	const id = getRouterParam(event, "id");
	if (!id) {
		throw createError({
			statusCode: 400,
			statusMessage: "Missing library ID",
		});
	}

	const media = getMediaId(id);
	if (!media) {
		throw createError({
			statusCode: 404,
			statusMessage: "No media with ID " + id,
		});
	}

	for (const { provider, fetch } of LYRICS_PROVIDERS) {
		const paragraphs = await fetch(media);
		console.log(`[GET /library/${id}/lyrics] Testing ${provider}...`);

		if (paragraphs && paragraphs.length > 0) {
			return { provider, paragraphs };
		}
	}

	throw createError({
		statusCode: 404,
		statusMessage: "No lyrics found for " + id,
	});
});
