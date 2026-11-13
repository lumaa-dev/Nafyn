import { getLastfmAccount, lastfmCredentials, setLastfmScrobbling } from "~~/server/core/lastfmAccounts";

defineRouteMeta({
    openAPI: {
        description: "Pause or resume scrobbling to the connected Last.fm account",
        tags: ["user"],
        operationId: "updateLastfmConnection",
        requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["scrobbling"], properties: { scrobbling: { type: "boolean" } } } } }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/LastfmConnection" } } } },
            "400": { description: "Missing `scrobbling`", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No Last.fm account connected", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const body = await readBody(event).catch(() => null) as { scrobbling?: unknown } | null;
    if (typeof body?.scrobbling !== "boolean") throw createError({ statusCode: 400, statusMessage: "scrobbling must be a boolean" });

    if (!await setLastfmScrobbling(userId, body.scrobbling)) throw createError({ statusCode: 404, statusMessage: "No Last.fm account connected" });
    const account = await getLastfmAccount(userId);
    return { available: lastfmCredentials() !== null, username: account?.username ?? null, scrobbling: !!account?.scrobbling };
});
