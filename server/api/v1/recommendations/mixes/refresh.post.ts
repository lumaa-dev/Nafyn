import { requireAuthToken } from "~~/server/utils/requireAuth";
import { MANUAL_REFRESH_COOLDOWN_MS, getRefreshState, refreshUserMixes } from "~~/server/core/recMixes";
import { requirePersonalization } from "~~/server/utils/recRequest";

defineRouteMeta({
    openAPI: {
        description: "Rebuilds the caller's mixes now, in the background (it can take a few minutes: catalogue lookups are rate limited). At most once every 10 minutes; follow `refreshing` on GET /api/v1/recommendations/mixes.",
        tags: ["recommendations"],
        operationId: "refreshMixes",
        responses: {
            "202": { description: "Started (or already running)", content: { "application/json": { schema: { type: "object", required: ["refreshing"], properties: { refreshing: { type: "boolean" } } } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "The caller turned personalized recommendations off", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Refreshed less than 10 minutes ago", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    await requirePersonalization(userId);
    const state = await getRefreshState(userId);
    if (state.refreshing) {
        setResponseStatus(event, 202);
        return { refreshing: true };
    }
    if (state.refreshedAt && Date.now() - state.refreshedAt < MANUAL_REFRESH_COOLDOWN_MS) {
        setResponseHeader(event, "Retry-After", Math.ceil((MANUAL_REFRESH_COOLDOWN_MS - (Date.now() - state.refreshedAt)) / 1000));
        throw createError({ statusCode: 429, statusMessage: "Mixes were refreshed a moment ago" });
    }
    refreshUserMixes(userId).catch((error) => console.error("[recommendations] manual mix refresh failed:", error));
    setResponseStatus(event, 202);
    return { refreshing: true };
});
