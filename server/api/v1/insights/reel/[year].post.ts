import { queueReel } from "~~/server/core/insightsReel";
import { parseYear } from "~~/server/utils/insightsPeriod";
import { consumeRateLimit } from "~~/server/utils/rateLimit";

// rendering is the single most expensive thing this process does, so a user gets a handful of requests per
// hour rather than as many as they can click
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

defineRouteMeta({
    openAPI: {
        description: "Request the optional server-rendered MP4 of the requesting user's highlight reel for a year: a montage of the year's top tracks' album art with short audio excerpts and the headline numbers burnt in. Rendering is opt-in and queued - reels are produced one at a time. Poll GET /api/v1/insights/reel/{year} for progress; a request for a reel already queued or rendering is a no-op.",
        tags: ["insights"],
        operationId: "requestHighlightReelVideo",
        parameters: [
            { name: "year", in: "path", required: true, schema: { type: "integer" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["reelStatus"],
                            properties: { reelStatus: { type: "string", enum: ["queued", "rendering", "ready", "failed"] } }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No year-end snapshot to build a reel from yet", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many render requests", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const year = parseYear(getRouterParam(event, "year"));

    const limit = consumeRateLimit(`insights:reel:${userId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
    if (!limit.allowed) {
        setResponseHeader(event, "Retry-After", limit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many render requests" });
    }

    return { reelStatus: await queueReel(userId, year) };
});
