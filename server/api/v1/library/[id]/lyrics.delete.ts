// DELETE /api/v1/library/{id}/lyrics - drop the user-supplied lyrics, so the track falls back to the
// fetched providers again (Cider, LRCLIB)
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { requireEditableMedia } from "~~/server/utils/mediaAccess";
import { deleteMediaLyrics } from "~~/server/core/mediaLyrics";

defineRouteMeta({
    openAPI: {
        description: "Remove the user-supplied lyrics of a library track",
        tags: ["library"],
        operationId: "deleteTrackLyrics",
        parameters: [
            { name: "id", in: "path", required: true, description: "Nafyn media ID", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "Removed" },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "Track not found in your library", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const media = await requireEditableMedia(userId, getRouterParam(event, "id"));
    const mediaId = media.id;

    await deleteMediaLyrics(mediaId);
    return { removed: true };
});
