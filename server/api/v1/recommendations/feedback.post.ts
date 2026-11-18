import { requireAuthToken } from "~~/server/utils/requireAuth";
import { recordFeedback } from "~~/server/core/recBandit";
import { requirePersonalization } from "~~/server/utils/recRequest";

const EVENTS = ["open", "play", "preview", "request"] as const;

defineRouteMeta({
    openAPI: {
        description: "What the person did with a card of the Discover page (or a track opened from it), within 30 minutes of the page being served. `open`: the card was opened. `play`: playback started from it, `msPlayed` how long it was listened to (send it when the listen ends). `preview`: a suggestion's preview was listened to for `msPlayed`. `request`: a suggestion was requested. A card nobody touched counts as ignored when the window closes.",
        tags: ["recommendations"],
        operationId: "postRecommendationFeedback",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["decisionId", "slot", "event"],
                        properties: {
                            decisionId: { type: "string" },
                            slot: { type: "integer", minimum: 0 },
                            event: { type: "string", enum: [...EVENTS] },
                            msPlayed: { type: "integer", minimum: 0 }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["recorded", "closed"], description: "closed: the window is over, nothing was recorded" } } } } } },
            "400": { description: "Invalid body", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No such decision for the caller", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    await requirePersonalization(userId);
    const body = await readBody(event);
    const decisionId = typeof body?.decisionId === "string" ? body.decisionId : "";
    const slot = Number(body?.slot);
    const kind = body?.event;
    const msPlayed = Number(body?.msPlayed ?? 0);
    if (!/^[0-9a-f-]{36}$/i.test(decisionId) || !Number.isInteger(slot) || !EVENTS.includes(kind) || !Number.isFinite(msPlayed) || msPlayed < 0) {
        throw createError({ statusCode: 400, statusMessage: "Invalid feedback" });
    }
    const status = await recordFeedback(userId, decisionId, slot, kind, msPlayed);
    if (status === "missing") throw createError({ statusCode: 404, statusMessage: "Unknown recommendation" });
    return { status };
});
