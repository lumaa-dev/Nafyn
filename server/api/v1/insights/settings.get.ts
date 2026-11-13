import { isScrobbling } from "~~/server/core/lastfmAccounts";
import { getInsightSettings } from "~~/server/core/insightsSettings";

defineRouteMeta({
    openAPI: {
        description: "The requesting user's listening-history preferences. Always scoped to the caller - there is no way to read another user's setting.",
        tags: ["insights"],
        operationId: "getInsightsSettings",
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { $ref: "#/components/schemas/InsightsSettings" } } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    InsightsSettings: {
                        type: "object",
                        required: ["historyEnabled", "enabledAt", "disabledAt", "tzOffsetMinutes"],
                        properties: {
                            historyEnabled: { type: "boolean", description: "Opt-in; false by default and for users who have never touched the setting" },
                            enabledAt: { type: "integer", format: "int64", nullable: true, description: "Epoch ms the setting was last switched on" },
                            disabledAt: { type: "integer", format: "int64", nullable: true, description: "Epoch ms the setting was last switched off" },
                            tzOffsetMinutes: { type: "integer", description: "Minutes to add to UTC to reach the user's local time; decides where their day, week and year boundaries fall" },
                            scrobbling: { type: "boolean", description: "GET only: plays are scrobbled to Last.fm, so a client reports them (POST /insights/events) even with the history off" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    // `scrobbling`: plays must still be reported while the history is off, for Last.fm (see POST /insights/events)
    return { ...await getInsightSettings(userId), scrobbling: await isScrobbling(userId) };
});
