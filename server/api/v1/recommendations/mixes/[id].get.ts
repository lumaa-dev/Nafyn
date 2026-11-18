import { requireAuthToken } from "~~/server/utils/requireAuth";
import { getMix } from "~~/server/core/recMixes";
import { requirePersonalization } from "~~/server/utils/recRequest";

defineRouteMeta({
    openAPI: {
        description: "One mix, in listening order. A familiar track carries its `media` row (playable like any library or playlist track); a suggestion carries the catalogue `suggestion` (recording MBID, requestable, with a 30-second preview at /api/v1/track/{tid}/preview). `reason` says why each track is there.",
        tags: ["recommendations"],
        operationId: "getMix",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            allOf: [
                                { $ref: "#/components/schemas/MixSummary" },
                                {
                                    type: "object",
                                    required: ["tracks"],
                                    properties: {
                                        tracks: {
                                            type: "array",
                                            items: {
                                                type: "object",
                                                required: ["position", "familiar", "confidence", "reason"],
                                                properties: {
                                                    position: { type: "integer" },
                                                    familiar: { type: "boolean" },
                                                    confidence: { type: "number", description: "Familiar: how sure Nafyn is the caller likes it. Suggestion: how well it fits the mix (0-1)" },
                                                    reason: {
                                                        type: "object",
                                                        required: ["kind"],
                                                        properties: {
                                                            kind: { type: "string", enum: ["familiar", "novel"] },
                                                            plays: { type: "integer" },
                                                            lastPlayedAt: { type: "number", nullable: true },
                                                            via: { type: "string", enum: ["collaborative", "audio", "text", "graph"], description: "Suggestions: the evidence that weighed most" },
                                                            seedArtist: { type: "string", nullable: true, description: "Suggestions: the caller's artist it was found through" },
                                                            fit: { type: "number" }
                                                        }
                                                    },
                                                    media: { type: "object", nullable: true, description: "Familiar tracks: the media row, plus `inLibrary`" },
                                                    suggestion: {
                                                        type: "object",
                                                        nullable: true,
                                                        properties: {
                                                            recordingId: { type: "string" },
                                                            title: { type: "string" },
                                                            artist: { type: "string" },
                                                            album: { type: "string", nullable: true },
                                                            albumId: { type: "string", nullable: true },
                                                            coverArt: { type: "string", nullable: true },
                                                            durationMs: { type: "number", nullable: true },
                                                            releasedAt: { type: "number", nullable: true }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            ]
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "The caller turned personalized recommendations off", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No such mix for the caller", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    await requirePersonalization(userId);
    const id = getRouterParam(event, "id") ?? "";
    const mix = /^[0-9a-f-]{36}$/i.test(id) ? await getMix(userId, id) : null;
    if (!mix) throw createError({ statusCode: 404, statusMessage: "Mix not found" });
    return mix;
});
