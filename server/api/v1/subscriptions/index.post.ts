import { createSubscription, SubscriptionError } from "~~/server/core/releaseSubscriptions";
import { assertMbid } from "~~/server/utils/ids";
import { isValidTimeZone } from "~~/server/utils/releaseDate";
import { consumeRateLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "Follow an unreleased album or track: at local midnight on its release date (in `timezone`) the user is notified over APNs and their own webhooks, and Apple devices get a countdown Live Activity 3 hours before. Already-released media is refused (409) - request it instead",
        tags: ["subscriptions"],
        operationId: "createReleaseSubscription",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["id", "type", "timezone"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz ID (release-group for an album, recording for a track)" },
                            type: { type: "string", enum: ["album", "track"] },
                            timezone: { type: "string", description: "IANA timezone, e.g. Europe/Paris" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { $ref: "#/components/schemas/ReleaseSubscription" } } }
            },
            "400": { description: "Malformed ID, type or timezone", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "Not found on MusicBrainz", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "Already released, or no announced release date", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

// each subscription costs a MusicBrainz lookup now and a daily one until release
const MAX_SUBSCRIBES = 30;
const SUBSCRIBE_WINDOW_MS = 10 * 60 * 1000;

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const rateLimit = consumeRateLimit(`subscribe:${userId}`, MAX_SUBSCRIBES, SUBSCRIBE_WINDOW_MS);
    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many subscriptions, try again later" });
    }

    const body = await readBody(event).catch(() => null);
    const type = body?.type;
    if (type !== "album" && type !== "track") {
        throw createError({ statusCode: 400, statusMessage: "Incorrect media type" });
    }
    const mbId = assertMbid(body?.id);
    if (!isValidTimeZone(body?.timezone)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid timezone" });
    }

    try {
        return await createSubscription(userId, mbId, type, body.timezone);
    } catch (err) {
        if (err instanceof SubscriptionError) throw createError({ statusCode: err.statusCode, statusMessage: err.message });
        throw err;
    }
});
