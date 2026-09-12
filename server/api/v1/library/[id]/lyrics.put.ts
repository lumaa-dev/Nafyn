// PUT /api/v1/library/{id}/lyrics - store lyrics the user supplies for one of their tracks.
//
// Whatever is stored here wins over every fetched provider in lyrics.get.ts, and for a manually imported
// track it is the only source there is (Cider/LRCLIB have never heard of it). The content is saved exactly
// as submitted - Nafyn neither authors nor rewrites it.
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { findLibraryEntry, getMediaId } from "~~/server/core/library";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { MAX_LYRICS_LENGTH, setMediaLyrics, type LyricsFormat } from "~~/server/core/mediaLyrics";

defineRouteMeta({
    openAPI: {
        description: "Set user-supplied lyrics for a library track. `format` is `plain` (untimed text) or `lrc` (LRC-timed lines).",
        tags: ["library"],
        operationId: "setTrackLyrics",
        parameters: [
            { name: "id", in: "path", required: true, description: "Nafyn media ID", schema: { type: "string" } }
        ],
        requestBody: {
            required: true,
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["content"],
                        properties: {
                            content: { type: "string", description: `Lyrics text, max ${MAX_LYRICS_LENGTH} characters` },
                            format: { type: "string", enum: ["plain", "lrc"], default: "plain" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "The stored lyrics" },
            "400": { description: "Missing or oversized content", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "Track not found in your library", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const mediaId = getRouterParam(event, "id");
    if (!mediaId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media ID" });
    }

    const media = await getMediaId(mediaId);
    if (!media) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    if (!await findLibraryEntry(userId, mediaId)) {
        if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC)) {
            throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
        }
    }

    const body = await readBody(event).catch(() => null);
    const content = typeof body?.content === "string" ? body.content : null;
    if (!content || content.trim().length === 0) {
        throw createError({ statusCode: 400, statusMessage: "`content` must be a non-empty string" });
    }
    if (content.length > MAX_LYRICS_LENGTH) {
        throw createError({ statusCode: 400, statusMessage: `Lyrics are too long (max ${MAX_LYRICS_LENGTH} characters)` });
    }

    const format: LyricsFormat = String(body?.format ?? "plain").toLowerCase() === "lrc" ? "lrc" : "plain";

    return await setMediaLyrics(mediaId, format, content);
});
