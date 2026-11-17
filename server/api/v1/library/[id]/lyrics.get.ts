import { getMediaLyrics } from "~~/server/core/mediaLyrics";
import { getMediaId, findPlayableEntry } from "~~/server/core/library";
import { getTrackLyrics } from "~~/server/core/lyrics";

defineRouteMeta({
	openAPI: {
		description: "Get the lyrics of a library track: user-supplied lyrics first, then the fetched providers (Unison, Better Lyrics, Better Lyrics Portato, Cider, LRCLIB) in that order until one has a match. Lyrics are parsed by Braccato (`@braccato/parsers`) and returned as its `Lyric[]` shape (`@braccato/types`). Answers are cached for 20 minutes, together with the track's lyric offset (`PUT /api/v1/library/{id}/lyrics/offset`). Pass `?source=1` to get the stored user-supplied lyrics verbatim instead.",
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
							required: ["provider", "syncType", "lyrics", "songwriters", "offsetMs"],
							properties: {
								provider: { type: "string", enum: ["manual", "betterLyrics", "unison", "betterLyricsPortato", "cider", "lrclib", "cache"] },
								syncType: { type: "string", enum: ["richsync", "synced", "none"], description: "`richsync`: lines carry timed `parts` (syllable/word), `synced`: timed lines, `none`: unsynced text" },
								offsetMs: { type: "integer", description: "Milliseconds the lyrics are shown later (negative: earlier) than their own timing. Shared by everyone who can play the track, kept with the cached lyrics (20 minutes)." },
								songwriters: { type: "array", items: { type: "string" }, description: "Who wrote the song, as the lyrics file credits them" },
								language: { type: "string", description: "BCP 47 language the lyrics file declares" },
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
								lyrics: {
									type: "array",
									description: "Braccato `Lyric[]` (`@braccato/types`), in order. Times are milliseconds from the start of the track.",
									items: {
										type: "object",
										required: ["startTimeMs", "durationMs", "words"],
										properties: {
											startTimeMs: { type: "number" },
											durationMs: { type: "number" },
											words: { type: "string", description: "The whole line (background vocals included)" },
											key: { type: "string" },
											agent: { type: "string", description: "Singer slot: `v1`, `v2`... (`v1000` = everyone)" },
											isInstrumental: { type: "boolean", description: "A gap nobody sings over (no words)" },
											parts: { type: "array", description: "Syllable/word timing", items: {
													type: "object",
													required: ["startTimeMs", "durationMs", "words"],
													properties: {
														startTimeMs: { type: "number" },
														durationMs: { type: "number" },
														words: { type: "string" },
														isBackground: { type: "boolean", description: "A background vocal, sung over the line" },
														backgroundGroup: { type: "integer", description: "Which of the line's background groups the part is in, from 0" },
														explicit: { type: "boolean" }
													}
												} },
											translation: { type: "object", required: ["text", "lang"], properties: { text: { type: "string" }, lang: { type: "string" } } },
											translations: { type: "object", additionalProperties: { type: "string" } },
											romanization: { type: "string" },
											timedRomanization: { type: "array", items: {
													type: "object",
													required: ["startTimeMs", "durationMs", "words"],
													properties: {
														startTimeMs: { type: "number" },
														durationMs: { type: "number" },
														words: { type: "string" },
														isBackground: { type: "boolean", description: "A background vocal, sung over the line" },
														backgroundGroup: { type: "integer", description: "Which of the line's background groups the part is in, from 0" },
														explicit: { type: "boolean" }
													}
												} }
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
	// prefill - the parsed `Lyric[]` below is for playback, not for editing
	if (getQuery(event).source !== undefined) {
		return await getMediaLyrics(media.id);
	}

	const found = await getTrackLyrics(media);
	if (found) return found;

	throw createError({
		statusCode: 404,
		statusMessage: "No lyrics found for " + id,
	});
});
