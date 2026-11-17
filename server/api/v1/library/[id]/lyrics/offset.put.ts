// PUT /api/v1/library/{id}/lyrics/offset - move a track's lyrics earlier or later against its audio.
//
// The offset is kept with the cached lyrics (server/utils/lyrics/cache.ts): it corrects those lyrics for the
// track's audio file, which every user shares, so it is the track's - not one account's - and it lasts as long as
// the cached lyrics do (20 minutes; a new fetch, or an edit of the user-written lyrics, starts again from 0).
// Anyone who can play the track can set it, like they can read its lyrics.
import { findPlayableEntry, getMediaId } from "~~/server/core/library";
import { getTrackLyrics, trackLyricsKey } from "~~/server/core/lyrics";
import { clampLyricsOffset, MAX_LYRICS_OFFSET_MS, setCachedLyricsOffset } from "~~/server/utils/lyrics/cache";

defineRouteMeta({
	openAPI: {
		description: "Set the lyric offset of a library track: how many milliseconds its lyrics are shown later (negative: earlier) than their own timing, within +-30000. The offset belongs to the track (every listener of it gets it) and is kept with its cached lyrics, so it lasts as long as they do (20 minutes). Only synced lyrics take one.",
		tags: ["library"],
		operationId: "setLyricsOffset",
		parameters: [
			{ name: "id", in: "path", required: true, description: "Media ID", schema: { type: "string" } }
		],
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["offsetMs"],
						properties: {
							offsetMs: { type: "integer", minimum: -30000, maximum: 30000, description: "Positive: the lyrics come later; negative: earlier" }
						}
					}
				}
			}
		},
		responses: {
			"200": {
				description: "The offset now in use",
				content: {
					"application/json": {
						schema: { type: "object", required: ["offsetMs"], properties: { offsetMs: { type: "integer" } } }
					}
				}
			},
			"400": { description: "`offsetMs` missing or not a number", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
			"401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
			"404": { description: "No media with that ID, or no synced lyrics for it", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
		}
	},
});

export default defineEventHandler(async (event) => {
	const { sub: userId } = await requireAuthToken(event);

	const id = getRouterParam(event, "id");
	const media = id ? await getMediaId(id) : null;
	// same rule as reading the lyrics: a track the caller cannot play is reported as absent
	if (!media || !await findPlayableEntry(userId, media.id)) {
		throw createError({ statusCode: 404, statusMessage: "No media with ID " + id });
	}

	const body = await readBody<{ offsetMs?: unknown }>(event).catch(() => null);
	const offsetMs = body?.offsetMs;
	if (typeof offsetMs !== "number" || !Number.isFinite(offsetMs)) {
		throw createError({ statusCode: 400, statusMessage: `offsetMs must be a number of milliseconds (+-${MAX_LYRICS_OFFSET_MS})` });
	}

	// the offset is stored next to the lyrics it moves, so they have to be cached first (usually they already are:
	// the player asked for them)
	const lyrics = await getTrackLyrics(media);
	if (!lyrics || lyrics.syncType === "none" || !setCachedLyricsOffset(await trackLyricsKey(media), offsetMs)) {
		throw createError({ statusCode: 404, statusMessage: "No synced lyrics for " + id });
	}

	return { offsetMs: clampLyricsOffset(offsetMs) };
});
