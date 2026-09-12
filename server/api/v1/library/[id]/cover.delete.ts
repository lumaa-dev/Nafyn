// DELETE /api/v1/library/{id}/cover - drop a user-uploaded cover, falling back to whatever `coverArt` holds
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { findLibraryEntry, getMediaId, setMediaCustomCover } from "~~/server/core/library";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { deleteMediaCover } from "~~/server/utils/mediaCover";

defineRouteMeta({
    openAPI: {
        description: "Remove the user-uploaded cover image of a library track",
        tags: ["library"],
        operationId: "deleteTrackCover",
        parameters: [
            { name: "id", in: "path", required: true, description: "Nafyn media ID", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "The updated media row", content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRow" } } } },
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

    await deleteMediaCover(mediaId);
    await setMediaCustomCover(mediaId, false);

    return { ...media, hasCustomCover: 0 };
});
