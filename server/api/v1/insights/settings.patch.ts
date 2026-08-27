import { setHistoryEnabled, getInsightSettings } from "~~/server/core/insightsSettings";

defineRouteMeta({
    openAPI: {
        description: "Turn the requesting user's listening history on or off. Switching it off stops new events being accepted immediately, but does not delete anything already recorded - use DELETE /api/v1/insights/history for that.",
        tags: ["insights"],
        operationId: "updateInsightsSettings",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            historyEnabled: { type: "boolean" },
                            tzOffsetMinutes: { type: "integer", description: "Minutes to add to UTC to reach local time, clamped to [-720, 840]. Only stored when present." }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/InsightsSettings" } } } },
            "400": { description: "No changes provided", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const body = await readBody(event);

    const tzOffsetMinutes = typeof body?.tzOffsetMinutes === "number" ? body.tzOffsetMinutes : undefined;

    if (typeof body?.historyEnabled !== "boolean") {
        // a tz-only update is legitimate (the browser reporting a travelled-to zone), so only reject a body
        // that asks for nothing at all
        if (tzOffsetMinutes === undefined) {
            throw createError({ statusCode: 400, statusMessage: "No changes provided" });
        }
        const current = await getInsightSettings(userId);
        return await setHistoryEnabled(userId, current.historyEnabled, tzOffsetMinutes);
    }

    return await setHistoryEnabled(userId, body.historyEnabled, tzOffsetMinutes);
});
