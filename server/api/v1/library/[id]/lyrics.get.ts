import {
	NafynLyrics,
	Provider,
	type LyricParagraphs,
} from "~~/server/utils/lyrics/parser";
import { fetchLrclibParagraphs, parseLrcSyncedLyrics, parsePlainLyrics } from "~~/server/utils/lyrics/lrclib";
import { getMediaLyrics } from "~~/server/core/mediaLyrics";
import { getMediaId, findLibraryEntry, type MediaRow } from "~~/server/core/library";

const lyricsService = new NafynLyrics();

defineRouteMeta({
	openAPI: {
		description: "Get synced lyrics for a library track: user-supplied lyrics first, then the fetched providers (Cider, LRCLIB) in order until one has a match. Pass `?source=1` to get the stored user-supplied lyrics verbatim instead.",
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
								provider: { type: "string", enum: ["appleMusic", "cider", "lrclib", "cache"] },
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
	const { sub: userId } = requireAuthToken(event);

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
	if (!media || !await findLibraryEntry(userId, media.id)) {
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
