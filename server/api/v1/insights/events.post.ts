// batch ingestion for play events - the one write path into the append-only store.
import { insertPlayEvents } from "~~/server/core/playEvents";
import { isHistoryEnabled } from "~~/server/core/insightsSettings";
import { parsePlayEventBatch, MAX_BATCH_SIZE } from "~~/server/utils/insightsValidate";
import { requireAuthTokenAllowQuery } from "~~/server/utils/requireAuth";
import { consumeRateLimit } from "~~/server/utils/rateLimit";

// generous enough that a heavy listener flushing every 30s never sees it, tight enough that a runaway client
// (or someone trying to bulk-fabricate a listening history) can't hammer the store
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;

defineRouteMeta({
    openAPI: {
        description: "Ingest a batch of play events for the requesting user. Idempotent: an event whose `event_id` already exists is silently ignored, so a client may safely retry a flush. Events are discarded (not rejected) when the user's Listening History setting is off, and events for tracks outside the user's library are never recorded. `album_id`/`artist_id` are resolved server-side and cannot be supplied by the client. Accepts `?token=` as an auth fallback for the `navigator.sendBeacon` flush on page unload.",
        tags: ["insights"],
        operationId: "ingestPlayEvents",
        parameters: [
            {
                name: "token",
                in: "query",
                required: false,
                description: "Auth token, as a fallback for `navigator.sendBeacon`, which cannot set headers",
                schema: { type: "string" }
            }
        ],
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["events"],
                        properties: {
                            events: {
                                type: "array",
                                maxItems: MAX_BATCH_SIZE,
                                items: { $ref: "#/components/schemas/PlayEventInput" }
                            }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["accepted", "rejected", "historyEnabled"],
                            properties: {
                                accepted: { type: "integer", description: "Events newly written to the store" },
                                rejected: { type: "integer", description: "Entries dropped as malformed, duplicated within the batch, or referencing a track outside the user's library" },
                                historyEnabled: { type: "boolean", description: "False means the batch was accepted and discarded; the client should stop sending" }
                            }
                        }
                    }
                }
            },
            "400": { description: "Malformed batch", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many ingestion requests", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    PlayEventInput: {
                        type: "object",
                        required: ["event_id", "track_id", "started_at", "duration_ms", "source"],
                        properties: {
                            event_id: { type: "string", format: "uuid", description: "Client-minted UUID; the idempotency key for this play" },
                            track_id: { type: "string", format: "uuid", description: "Nafyn media ID" },
                            playlist_id: { type: "string", format: "uuid", nullable: true, description: "Set only when the play started from a playlist the user can access; otherwise stored as null" },
                            started_at: { type: "integer", format: "int64", description: "Epoch milliseconds. Rejected if more than 7 days in the past or 5 minutes in the future" },
                            duration_ms: { type: "integer", description: "Wall-clock milliseconds actually played, excluding paused time. Clamped to [0, 86400000]" },
                            completed: { type: "boolean", description: "Playback reached the end of the file" },
                            source: { type: "string", enum: ["library", "playlist", "album", "track"] }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthTokenAllowQuery(event);

    // keyed on the (bounded, authenticated) user id rather than anything the caller controls, so the
    // in-memory bucket map can't be grown without bound by a flood of made-up keys
    const limit = consumeRateLimit(`insights:events:${userId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
    if (!limit.allowed) {
        setResponseHeader(event, "Retry-After", limit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many ingestion requests" });
    }

    const body = await readBody(event);
    const { events, rejected } = parsePlayEventBatch(body);

    // Accept-and-discard rather than 4xx. A tab left open across a settings change would otherwise sit in an
    // error loop it can't recover from, and answering "yes, received" to a client whose events are being
    // dropped is exactly what lets it clear its queue and stop asking.
    if (!await isHistoryEnabled(userId)) {
        return { accepted: 0, rejected: rejected + events.length, historyEnabled: false };
    }

    const result = await insertPlayEvents(userId, events);

    return {
        accepted: result.accepted,
        rejected: rejected + result.unknownTracks,
        historyEnabled: true
    };
});
