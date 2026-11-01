import {
	NafynLyrics,
	Provider,
	type LyricParagraphs,
} from "~~/server/utils/lyrics/parser";
import { fetchLrclibParagraphs, parseLrcSyncedLyrics, parsePlainLyrics } from "~~/server/utils/lyrics/lrclib";
import { fetchBetterLyricsParagraphs } from "~~/server/utils/lyrics/betterlyrics";
import { fetchUnisonParagraphs } from "~~/server/utils/lyrics/unison";
import type { TrackLookup } from "~~/server/utils/lyrics/match";
import { getMediaLyrics } from "~~/server/core/mediaLyrics";
import { getMediaId, findPlayableEntry, type MediaRow } from "~~/server/core/library";

const lyricsService = new NafynLyrics();

// What the providers said for a track, kept for 20 minutes so replaying (or merely loading the page of) a track
// doesn't ask any provider again; once the entry has expired the next request fetches and caches afresh.
// "Nothing found" is cached for as long, so a song no provider has costs one round of calls per 20 minutes, not
// one per play. User-supplied lyrics are not cached here: they are one cheap database read and an edit must show
// immediately. The key carries what the providers are asked (title, artist, album, length), so an edit of the
// track's metadata is never answered with lyrics fetched for the old one. Capped, oldest first.
const LYRICS_CACHE_TTL_MS = 20 * 60 * 1000;
const MAX_CACHED_TRACKS = 500;
const providerCache = new Map<string, { result: { provider: Provider, paragraphs: LyricParagraphs } | null, expiresAtMs: number }>();
const providerInFlight = new Map<string, Promise<{ provider: Provider, paragraphs: LyricParagraphs } | null>>();

function lookupProviders(media: MediaRow): Promise<{ provider: Provider, paragraphs: LyricParagraphs } | null> {
	const key = [media.id, media.title, media.artistName, media.album ?? "", media.duration, media.amId ?? ""].join("\u0000");
	const cached = providerCache.get(key);
	if (cached && cached.expiresAtMs > Date.now()) return Promise.resolve(cached.result);

	// two players asking for the same track at once share one round of provider calls
	let running = providerInFlight.get(key);
	if (!running) {
		running = (async () => {
			let result: { provider: Provider, paragraphs: LyricParagraphs } | null = null;
			for (const { provider, fetch } of LYRICS_PROVIDERS) {
				const paragraphs = await fetch(media);
				if (paragraphs && paragraphs.length > 0) {
					result = { provider, paragraphs };
					break;
				}
			}

			if (providerCache.size >= MAX_CACHED_TRACKS) providerCache.delete(providerCache.keys().next().value!);
			providerCache.set(key, { result, expiresAtMs: Date.now() + LYRICS_CACHE_TTL_MS });
			return result;
		})().finally(() => providerInFlight.delete(key));
		providerInFlight.set(key, running);
	}
	return running;
}

defineRouteMeta({
	openAPI: {
		description: "Get synced lyrics for a library track: user-supplied lyrics first, then the fetched providers (Better Lyrics, Unison, Cider, LRCLIB) in that order until one has a match; provider answers are cached for 20 minutes. Pass `?source=1` to get the stored user-supplied lyrics verbatim instead.",
		tags: ["library"],
		operationId: "getLyrics",
		parameters: [
			{
				name: "id",
				in: "path",
				required: true,
				description: "Media ID",
				schema: { type: "string" }
			}
		],
		responses: {
			"200": {
				description: "",
				content: {
					"application/json": {
						schema: {
							type: "object",
							required: ["provider", "paragraphs"],
							properties: {
								provider: { type: "string", enum: ["manual", "betterLyrics", "unison", "cider", "lrclib", "cache"] },
								paragraphs: {
									type: "array",
									items: {
										type: "object",
										required: ["id", "lines"],
										properties: {
											id: { type: "string" },
											lines: {
												type: "array",
												items: {
													type: "object",
													required: ["id", "text", "startTime", "endTime", "type", "segments"],
													properties: {
														id: { type: "string" },
														text: { type: "string" },
														startTime: { type: "number" },
														endTime: { type: "number" },
														type: {
															type: "object",
															required: ["kind", "alt"],
															properties: {
																kind: { type: "string", enum: ["main", "background"] },
																alt: { type: "boolean" }
															}
														},
														segments: {
															type: "array",
															items: {
																type: "object",
																required: ["id", "text", "startTime", "endTime", "endsWord"],
																properties: {
																	id: { type: "string" },
																	text: { type: "string" },
																	startTime: { type: "number" },
																	endTime: { type: "number" },
																	endsWord: { type: "boolean" }
																}
															}
														}
													}
												}
											}
										}
									}
								}
							}
						}
					}
				}
			},
			"400": {
				description: "Missing library ID",
				content: {
					"application/json": {
						schema: { $ref: "#/components/schemas/NuxtError" }
					}
				}
			},
			"401": {
				description: "Not authenticated",
				content: {
					"application/json": {
						schema: { $ref: "#/components/schemas/NuxtError" }
					}
				}
			},
			"404": {
				description: "No media with that ID, or no lyrics found for it",
				content: {
					"application/json": {
						schema: { $ref: "#/components/schemas/NuxtError" }
					}
				}
			}
		}
	},
});

interface LyricsProvider {
	provider: Provider;
	fetch: (media: MediaRow) => Promise<LyricParagraphs | null>;
}

function lookupOf(media: MediaRow): TrackLookup {
	return {
		trackName: media.title,
		artistName: media.artistName,
		albumName: media.album ?? undefined,
		duration: media.duration || undefined,
	};
}

// in this order: the word-timed community providers first, then Cider (needs the track's catalogue id), then
// LRCLIB, which has the widest coverage but mostly line-timed lyrics
const LYRICS_PROVIDERS: LyricsProvider[] = [
	{
		provider: Provider.BetterLyrics,
		fetch: (media) => fetchBetterLyricsParagraphs(lookupOf(media)),
	},
	{
		provider: Provider.Unison,
		fetch: (media) => fetchUnisonParagraphs(lookupOf(media)),
	},
	{
		provider: Provider.Cider,
		fetch: (media) => media.amId ? lyricsService.fetchCiderParagraphs(media.amId) : Promise.resolve(null),
	},
	{
		provider: Provider.Lrclib,
		fetch: (media) => fetchLrclibParagraphs(lookupOf(media)),
	},
];

export default defineEventHandler(async (event) => {
	const { sub: userId } = await requireAuthToken(event);

	const id = getRouterParam(event, "id");
	if (!id) {
		throw createError({
			statusCode: 400,
			statusMessage: "Missing library ID",
		});
	}

	const media = await getMediaId(id);
	// SECURITY: scope this to the caller's own library like every other /library route. Serving lyrics for
	// an arbitrary media ID let any account both read metadata it has no access to and probe which IDs
	// exist across other users' libraries. A media row the caller can't see is reported as simply absent.
	if (!media || !await findPlayableEntry(userId, media.id)) {
		throw createError({
			statusCode: 404,
			statusMessage: "No media with ID " + id,
		});
	}

	// `?source=1` returns the *stored* user lyrics verbatim (or null), which is what the edit form needs to
	// prefill - the parsed-paragraph shape below is for playback, not for editing
	if (getQuery(event).source !== undefined) {
		return await getMediaLyrics(media.id);
	}

	// user-supplied lyrics win over every fetched provider: someone typed them in for this exact track, and
	// for a manually imported one no provider can know about it at all
	const manual = await getMediaLyrics(media.id);
	if (manual) {
		const paragraphs = manual.format === "lrc"
			? parseLrcSyncedLyrics(manual.content)
			: parsePlainLyrics(manual.content);

		if (paragraphs.length > 0) {
			return { provider: Provider.Manual, paragraphs };
		}
	}

	const found = await lookupProviders(media);
	if (found) return found;

	throw createError({
		statusCode: 404,
		statusMessage: "No lyrics found for " + id,
	});
});
