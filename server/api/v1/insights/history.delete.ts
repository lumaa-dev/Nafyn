import { deleteUserHistory } from "~~/server/core/playEvents";
import { listYearSnapshots } from "~~/server/core/insightsSnapshot";
import { deleteReelsForUser } from "~~/server/core/insightsReel";

defineRouteMeta({
    openAPI: {
        description: "Permanently erase the requesting user's entire listening history: raw play events, every aggregate, their Replay Mixes, their year-end snapshots and any rendered highlight reels. Irreversible, and scoped to the caller only. The Listening History setting itself is left as-is, so a user can wipe their data without also turning collection back off (or on).",
        tags: ["insights"],
        operationId: "deleteInsightsHistory",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["deleted"],
                            properties: { deleted: { type: "boolean" } }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    // reel files must be listed before the snapshot rows that name them are deleted
    const snapshots = await listYearSnapshots(userId);
    await deleteReelsForUser(userId, snapshots.map((s) => s.year));

    await deleteUserHistory(userId);

    return { deleted: true };
});
