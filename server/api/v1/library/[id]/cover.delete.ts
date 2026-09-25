// DELETE /api/v1/library/{id}/cover - drop a user-uploaded cover, falling back to whatever `coverArt` holds
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { requireEditableMedia } from "~~/server/utils/mediaAccess";
import { setMediaCustomCover } from "~~/server/core/library";
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

    const media = await requireEditableMedia(userId, getRouterParam(event, "id"));
    const mediaId = media.id;

    await deleteMediaCover(mediaId);
    await setMediaCustomCover(mediaId, false);

    return { ...media, hasCustomCover: 0 };
});
