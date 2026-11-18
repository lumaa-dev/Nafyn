import { requireAuthToken } from "~~/server/utils/requireAuth";
import { getRecSettings } from "~~/server/core/recSettings";
import { getRecConfig } from "~~/server/utils/recConfig";

defineRouteMeta({
    openAPI: {
        description: "Whether the caller's personalized recommendations (mixes, For You) are on. On by default; `available` is false when the instance has the recommender switched off.",
        tags: ["recommendations"],
        operationId: "getRecommendationSettings",
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/RecommendationSettings" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    RecommendationSettings: {
                        type: "object",
                        required: ["enabled", "available"],
                        properties: {
                            enabled: { type: "boolean" },
                            available: { type: "boolean" },
                            updatedAt: { type: "number", nullable: true }
                        }
                    }
                }
            }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    return { ...await getRecSettings(userId), available: getRecConfig().enabled };
});
