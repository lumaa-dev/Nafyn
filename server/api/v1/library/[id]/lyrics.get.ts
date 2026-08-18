import {
	NafynLyrics,
	Provider,
	type LyricParagraphs,
} from "~~/server/utils/lyrics/parser";
import { fetchLrclibParagraphs } from "~~/server/utils/lyrics/lrclib";
import { getMediaId, type MediaRow } from "~~/server/core/library";

const lyricsService = new NafynLyrics();

defineRouteMeta({
	openAPI: {
		description: "Get synced lyrics for a library track, tried across providers (Cider, LRCLIB) in order until one has a match",
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
	requireAuthToken(event);

	const id = getRouterParam(event, "id");
	if (!id) {
		throw createError({
			statusCode: 400,
			statusMessage: "Missing library ID",
		});
	}

	const media = await getMediaId(id);
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
