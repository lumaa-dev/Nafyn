import { deleteSubscription } from "~~/server/core/releaseSubscriptions";
import { assertMbid } from "~~/server/utils/ids";

defineRouteMeta({
    openAPI: {
        description: "Stop following an upcoming album/track (by its MusicBrainz ID)",
        tags: ["subscriptions"],
        operationId: "deleteReleaseSubscription",
        parameters: [{ name: "mbid", in: "path", required: true, schema: { type: "string" } }],
        responses: {
            "200": { description: "" },
            "400": { description: "Malformed MusicBrainz ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "Not subscribed", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const mbId = assertMbid(getRouterParam(event, "mbid"));

    if (!await deleteSubscription(userId, mbId)) {
        throw createError({ statusCode: 404, statusMessage: "Not subscribed" });
    }
    return { removed: true };
});
