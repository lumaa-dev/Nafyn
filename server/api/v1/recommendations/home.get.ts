import { requireAuthToken } from "~~/server/utils/requireAuth";
import { buildHomePage } from "~~/server/core/recBandit";
import { getRefreshState } from "~~/server/core/recMixes";
import { requestContext, requirePersonalization } from "~~/server/utils/recRequest";


defineRouteMeta({
    openAPI: {
        description: "The caller's For You page: shelves (rows) and their cards, ranked by the contextual bandit. Every shelf carries the `decisionId` its cards were chosen under: report what the person does with a card to POST /api/v1/recommendations/feedback with that id and the card's `slot`. `device` (web, ios, subsonic, other) and `tz` (minutes to add to UTC) describe the request's context.",
        tags: ["recommendations"],
        operationId: "getRecommendationsHome",
        parameters: [
            { in: "query", name: "device", schema: { type: "string", enum: ["web", "ios", "subsonic", "other"] } },
            { in: "query", name: "tz", schema: { type: "integer" }, description: "UTC offset of the client, in minutes (-720 to 840)" }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["pageId", "shelves", "refreshing"],
                            properties: {
                                pageId: { type: "string" },
                                refreshing: { type: "boolean", description: "Mixes are being (re)built right now" },
                                refreshedAt: { type: "number", nullable: true },
                                shelves: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        required: ["decisionId", "kind", "row", "cards"],
                                        properties: {
                                            decisionId: { type: "string" },
                                            kind: { type: "string", enum: ["mixes", "suggestions", "jump_back_in", "rediscover", "playlists"] },
                                            row: { type: "integer" },
                                            cards: {
                                                type: "array",
                                                items: {
                                                    type: "object",
                                                    required: ["slot", "actionId", "item", "explanation"],
                                                    properties: {
                                                        slot: { type: "integer" },
                                                        actionId: { type: "string" },
                                                        item: {
                                                    type: "object",
                                                    required: ["kind", "refId", "title", "href"],
                                                    properties: {
                                                        kind: { type: "string", enum: ["mix", "suggestion", "album", "playlist", "track"] },
                                                        refId: { type: "string", description: "Mix id, recording MBID (suggestion), release-group MBID (album) or playlist id" },
                                                        title: { type: "string" },
                                                        subtitle: { type: "string", nullable: true },
                                                        coverArt: { type: "string", nullable: true },
                                                        coverMediaId: { type: "string", nullable: true },
                                                        playlistImage: { type: "string", nullable: true },
                                                        covers: { type: "array", items: { type: "string" }, description: "Mixes: up to four covers" },
                                                        label: { $ref: "#/components/schemas/MixLabel" },
                                                        href: { type: "string", description: "Page in the web app" }
                                                    }
                                                },
                                                        explanation: { $ref: "#/components/schemas/RecommendationExplanation" }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "The caller turned personalized recommendations off", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "Recommendations are disabled on this instance", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    MixLabel: {
                        type: "object",
                        required: ["kind", "value"],
                        description: "What a mix is about. Clients write the title in their own language from it",
                        properties: {
                            kind: { type: "string", enum: ["genre", "decade", "mood", "time", "artist"] },
                            value: { type: "string", description: "genre name, \"1990s\", mood (upbeat, intense, mellow, melancholic), time (night, morning, afternoon, evening) or artist names" },
                            qualifier: { type: "object", properties: { kind: { type: "string" }, value: { type: "string" } } }
                        }
                    },
                    RecommendationExplanation: {
                        type: "object",
                        required: ["kind"],
                        properties: {
                            kind: { type: "string", enum: ["none", "because_artist", "from_mix", "new_release", "rediscover", "recently_played", "similar_to_recent"] },
                            subject: { type: "string", description: "The artist or mix the explanation names" }
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
    const page = await buildHomePage(userId, { ...requestContext(event), now: Date.now() });
    const state = await getRefreshState(userId);
    return { pageId: page.pageId, shelves: page.shelves, refreshing: state.refreshing, refreshedAt: state.refreshedAt };
});
