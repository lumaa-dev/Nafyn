import { requireAuthToken } from "~~/server/utils/requireAuth";
import { getRefreshState, listMixes } from "~~/server/core/recMixes";
import { requirePersonalization } from "~~/server/utils/recRequest";

defineRouteMeta({
    openAPI: {
        description: "The caller's personalized mixes (Made For You), one per listening mode Nafyn found in their library, playlists and plays. Built in the background and refreshed daily, or sooner after enough new listening.",
        tags: ["recommendations"],
        operationId: "getMixes",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["mixes", "refreshing"],
                            properties: {
                                refreshing: { type: "boolean" },
                                refreshedAt: { type: "number", nullable: true },
                                failed: { type: "boolean", description: "The last refresh failed (the previous mixes, if any, are still listed)" },
                                mixes: { type: "array", items: { $ref: "#/components/schemas/MixSummary" } }
                            }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "The caller turned personalized recommendations off", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    MixSummary: {
                        type: "object",
                        required: ["id", "position", "label", "title", "topArtists", "trackCount", "familiarCount", "covers", "refreshedAt"],
                        properties: {
                            id: { type: "string" },
                            position: { type: "integer" },
                            label: { $ref: "#/components/schemas/MixLabel" },
                            title: { type: "string", description: "English title, for clients that do not localize `label`" },
                            topArtists: { type: "array", items: { type: "string" } },
                            trackCount: { type: "integer" },
                            familiarCount: { type: "integer", description: "Tracks the caller can already play; the rest are suggestions" },
                            covers: { type: "array", items: { type: "string" } },
                            refreshedAt: { type: "number" }
                        }
                    }
                }
            }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    await requirePersonalization(userId);
    const [mixes, state] = await Promise.all([listMixes(userId), getRefreshState(userId)]);
    return { mixes, ...state };
});
