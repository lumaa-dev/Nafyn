import { requireAuthToken } from "~~/server/utils/requireAuth";
import { setPersonalizationEnabled } from "~~/server/core/recSettings";
import { getRecConfig } from "~~/server/utils/recConfig";

defineRouteMeta({
    openAPI: {
        description: "Turns the caller's personalized recommendations on or off. Turning them off deletes their mixes, ranking decisions and feedback at once, and their library is no longer used for anyone's recommendations.",
        tags: ["recommendations"],
        operationId: "updateRecommendationSettings",
        requestBody: { content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/RecommendationSettings" } } } },
            "400": { description: "No changes provided", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const body = await readBody(event);
    if (typeof body?.enabled !== "boolean") throw createError({ statusCode: 400, statusMessage: "No changes provided" });
    return { ...await setPersonalizationEnabled(userId, body.enabled), available: getRecConfig().enabled };
});
