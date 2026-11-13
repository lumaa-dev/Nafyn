import { sendNowPlaying } from "~~/server/core/lastfmAccounts";

defineRouteMeta({
    openAPI: {
        description: "Tell Last.fm what the user just started playing (track.updateNowPlaying), when scrobbling is on. Fire-and-forget: always answers at once. The scrobble itself comes from the play event (POST /api/v1/insights/events)",
        tags: ["user"],
        operationId: "lastfmNowPlaying",
        requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["mediaId"], properties: { mediaId: { type: "string" } } } } }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
            "400": { description: "Missing mediaId", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const body = await readBody(event).catch(() => null) as { mediaId?: unknown } | null;
    if (typeof body?.mediaId !== "string" || !body.mediaId) throw createError({ statusCode: 400, statusMessage: "mediaId is required" });
    sendNowPlaying(userId, body.mediaId);
    return { ok: true };
});
