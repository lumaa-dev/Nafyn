import {
	NafynLyrics,
	Provider,
	type LyricParagraphs,
} from "~~/server/utils/lyrics/parser";
import { fetchLrclibParagraphs, parseLrcSyncedLyrics, parsePlainLyrics } from "~~/server/utils/lyrics/lrclib";
import { fetchBetterLyricsParagraphs, fetchBetterLyricsPortatoParagraphs } from "~~/server/utils/lyrics/betterlyrics";
import { fetchUnison, type UnisonCredit } from "~~/server/utils/lyrics/unison";
import type { TrackLookup } from "~~/server/utils/lyrics/match";
import { getMediaLyrics } from "~~/server/core/mediaLyrics";
import { getMediaId, findPlayableEntry, getMediaIsrcs, type MediaRow } from "~~/server/core/library";

const lyricsService = new NafynLyrics();

// What the providers said for a track, kept for 20 minutes so replaying (or merely loading the page of) a track
// doesn't ask any provider again; once the entry has expired the next request fetches and caches afresh.
// "Nothing found" is cached for as long, so a song no provider has costs one round of calls per 20 minutes, not
// one per play. User-supplied lyrics are not cached here: they are one cheap database read and an edit must show
// immediately. The key carries what the providers are asked (title, artist, album, length), so an edit of the
// track's metadata is never answered with lyrics fetched for the old one. Capped, oldest first.
const LYRICS_CACHE_TTL_MS = 20 * 60 * 1000;
const MAX_CACHED_TRACKS = 500;
// `credit` is only set by providers whose licence asks for one (Unison)
interface LyricsResult { provider: Provider, paragraphs: LyricParagraphs, credit?: UnisonCredit }

const providerCache = new Map<string, { result: LyricsResult | null, expiresAtMs: number }>();
const providerInFlight = new Map<string, Promise<LyricsResult | null>>();

function lookupProviders(media: MediaRow, isrcs: string[]): Promise<LyricsResult | null> {
	const key = [media.id, media.title, media.artistName, media.album ?? "", media.duration, media.amId ?? "", isrcs.join(",")].join("\u0000");
	const cached = providerCache.get(key);
	if (cached && cached.expiresAtMs > Date.now()) return Promise.resolve(cached.result);

	// two players asking for the same track at once share one round of provider calls
	let running = providerInFlight.get(key);
	if (!running) {
		running = (async () => {
			let result: LyricsResult | null = null;
			const lookup = lookupOf(media, isrcs);
			for (const { provider, fetch } of LYRICS_PROVIDERS) {
				const found = await fetch(lookup, media);
				if (found && found.paragraphs.length > 0) {
					result = { provider, ...found };
					console.log(`[lyrics.get.ts] Lyrics result with ${provider}`);
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
		description: "Get synced lyrics for a library track: user-supplied lyrics first, then the fetched providers (Better Lyrics, Unison, Better Lyrics Portato, Cider, LRCLIB) in that order until one has a match; provider answers are cached for 20 minutes. Pass `?source=1` to get the stored user-supplied lyrics verbatim instead.",
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
								provider: { type: "string", enum: ["manual", "betterLyrics", "unison", "betterLyricsPortato", "cider", "lrclib", "cache"] },
								credit: {
									type: "object",
									description: "Present when the lyrics must be credited (Unison's licence): show `text` linked to `url`, and the submitter, if any, linked to its `url`.",
									required: ["text", "url"],
									properties: {
										text: { type: "string" },
										url: { type: "string" },
										submitter: {
											type: "object",
											nullable: true,
											required: ["name", "url"],
											properties: { name: { type: "string" }, url: { type: "string" } }
										}
									}
								},
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
	fetch: (lookup: TrackLookup, media: MediaRow) => Promise<{ paragraphs: LyricParagraphs, credit?: UnisonCredit } | null>;
}

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

const paragraphsOnly = async (paragraphs: Promise<LyricParagraphs | null>) => {
	const found = await paragraphs;
	return found ? { paragraphs: found } : null;
};

// in this order: the syllable-timed community providers first, then Portato (word-timed), then Cider (needs the track's catalogue id), then
// LRCLIB, which has the widest coverage but mostly line-timed lyrics
const LYRICS_PROVIDERS: LyricsProvider[] = [
	{
		provider: Provider.Unison,
		fetch: (lookup) => fetchUnison(lookup),
	},
	{
		provider: Provider.BetterLyrics,
		fetch: (lookup) => paragraphsOnly(fetchBetterLyricsParagraphs(lookup)),
	},
	{
		provider: Provider.BetterLyricsPortato,
		fetch: (lookup) => paragraphsOnly(fetchBetterLyricsPortatoParagraphs(lookup)),
	},
	{
		provider: Provider.Cider,
		fetch: (_lookup, media) => media.amId ? paragraphsOnly(lyricsService.fetchCiderParagraphs(media.amId)) : Promise.resolve(null),
	},
	{
		provider: Provider.Lrclib,
		fetch: (lookup) => paragraphsOnly(fetchLrclibParagraphs(lookup)),
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

	const found = await lookupProviders(media, await getMediaIsrcs(media.id));
	if (found) return found;

	throw createError({
		statusCode: 404,
		statusMessage: "No lyrics found for " + id,
	});
});
