// PUT /api/v1/library/{id}/album - put a track on another album (a MusicBrainz release-group). Same rules as
// the metadata edit: the row is shared, so an ordinary user may only move a track nobody else has.
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { requireEditableMedia } from "~~/server/utils/mediaAccess";
import { AlbumNotFoundError, moveMediaToAlbum } from "~~/server/core/mediaAlbum";
import { MusicBrainzError } from "~~/server/utils/musicbrainzRepository";

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

defineRouteMeta({
    openAPI: {
        description: "Move a track of the requesting user's library to another album. The album comes from MusicBrainz (title, type, cover, date and the track's position on it); the file moves into the album's folder, and the folder it leaves is removed when empty.",
        tags: ["library"],
        operationId: "changeTrackAlbum",
        parameters: [
            { name: "id", in: "path", required: true, description: "Nafyn media ID", schema: { type: "string" } }
        ],
        requestBody: {
            required: true,
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["albumId"],
                        properties: {
                            albumId: { type: "string", description: "MusicBrainz release-group ID of the album" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "The updated media row",
                content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRow" } } }
            },
            "400": { description: "Missing or malformed `albumId`", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "The track is shared with other users", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "Track not in your library, or no such album", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "503": { description: "MusicBrainz is unavailable", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const media = await requireEditableMedia(userId, getRouterParam(event, "id"));

    const body = await readBody(event).catch(() => null);
    const albumId = typeof body?.albumId === "string" ? body.albumId.trim() : "";
    if (!MBID_RE.test(albumId)) {
        throw createError({ statusCode: 400, statusMessage: "`albumId` must be a MusicBrainz release-group ID" });
    }

    try {
        const updated = await moveMediaToAlbum(media.id, albumId.toLowerCase());
        if (!updated) {
            throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
        }
        return updated;
    } catch (error) {
        if (error instanceof AlbumNotFoundError) {
            throw createError({ statusCode: 404, statusMessage: "That album could not be found on MusicBrainz" });
        }
        if (error instanceof MusicBrainzError) {
            // 400/404 = MusicBrainz knows no such release-group; anything else = busy or down
            if (error.status === 400 || error.status === 404) {
                throw createError({ statusCode: 404, statusMessage: "That album could not be found on MusicBrainz" });
            }
            setResponseHeader(event, "Retry-After", 30);
            throw createError({ statusCode: 503, statusMessage: "MusicBrainz is unavailable, try again later" });
        }
        throw error;
    }
});
