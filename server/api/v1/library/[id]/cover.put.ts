// PUT /api/v1/library/{id}/cover - upload a cover image for a track in your library.
//
// The image is stored on disk (see utils/mediaCover.ts) rather than in `media.coverArt`: that column is
// fetched server-side by the Subsonic cover proxy, so it stays restricted to Cover Art Archive URLs.
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { requireEditableMedia } from "~~/server/utils/mediaAccess";
import { setMediaCustomCover } from "~~/server/core/library";
import { saveMediaCover } from "~~/server/utils/mediaCover";

defineRouteMeta({
    openAPI: {
        description: "Upload a cover image (PNG/JPEG/WebP, `multipart/form-data` part named `cover`) for a library track",
        tags: ["library"],
        operationId: "setTrackCover",
        parameters: [
            { name: "id", in: "path", required: true, description: "Nafyn media ID", schema: { type: "string" } }
        ],
        requestBody: {
            required: true,
            content: {
                "multipart/form-data": {
                    schema: {
                        type: "object",
                        required: ["cover"],
                        properties: { cover: { type: "string", format: "binary" } }
                    }
                }
            }
        },
        responses: {
            "200": { description: "The updated media row", content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRow" } } } },
            "400": { description: "Missing or unreadable image", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "Track not found in your library", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "413": { description: "Image too large", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const media = await requireEditableMedia(userId, getRouterParam(event, "id"));
    const mediaId = media.id;

    const form = await readMultipartFormData(event);
    const file = form?.find((part) => part.name === "cover");
    if (!file?.data?.length) {
        throw createError({ statusCode: 400, statusMessage: "Missing `cover` file" });
    }

    await saveMediaCover(mediaId, file.data);
    await setMediaCustomCover(mediaId, true);

    return { ...media, hasCustomCover: 1 };
});
