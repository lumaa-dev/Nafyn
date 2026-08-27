import { getInsightSettings } from "~~/server/core/insightsSettings";
import { getReplayMix, listReplayYears } from "~~/server/core/replayMix";
import { localParts } from "~~/server/utils/insightsPeriod";

defineRouteMeta({
    openAPI: {
        description: "The requesting user's live Replay Mix for the current year: their top 100 tracks, rebuilt every Monday. The mix is read-only by design - it is not a row in the playlists table, so no playlist endpoint (and no admin) can rename, reorder, add to or delete it. The response also lists every archived year available.",
        tags: ["insights"],
        operationId: "getReplayMix",
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/ReplayMix" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    ReplayEntry: {
                        type: "object",
                        required: ["position", "trackId", "score", "playCount", "totalDurationMs", "minutes", "available"],
                        properties: {
                            position: { type: "integer", description: "0-based position in the mix" },
                            trackId: { type: "string", description: "Media ID" },
                            score: { type: "number" },
                            playCount: { type: "integer" },
                            totalDurationMs: { type: "integer", format: "int64" },
                            minutes: { type: "integer" },
                            title: { type: "string", nullable: true },
                            subtitle: { type: "string", nullable: true },
                            cover: { type: "string", nullable: true },
                            available: { type: "boolean", description: "False when the track has since left the user's library; it stays listed but cannot be played" },
                            media: { $ref: "#/components/schemas/MediaRow" }
                        }
                    },
                    ReplayMix: {
                        type: "object",
                        required: ["id", "year", "isAllTime", "entries"],
                        properties: {
                            id: { type: "string", example: "replay-2026", description: "Virtual identifier. Also how the mix appears over the Subsonic API, where it is likewise read-only." },
                            year: { type: "integer", description: "0 for the All-Time mix" },
                            isAllTime: { type: "boolean" },
                            refreshedAt: { type: "integer", format: "int64", nullable: true },
                            entries: { type: "array", items: { $ref: "#/components/schemas/ReplayEntry" } },
                            archive: {
                                type: "array",
                                description: "Every stored mix, newest first, including All-Time",
                                items: {
                                    type: "object",
                                    properties: {
                                        year: { type: "integer" },
                                        id: { type: "string" },
                                        trackCount: { type: "integer" },
                                        refreshedAt: { type: "integer", format: "int64", nullable: true }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const { tzOffsetMinutes } = await getInsightSettings(userId);

    const year = localParts(Date.now(), tzOffsetMinutes).year;
    const [mix, archive] = await Promise.all([
        getReplayMix(userId, year),
        listReplayYears(userId)
    ]);

    return { ...mix, archive };
});
