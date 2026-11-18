import { connectListenBrainz } from "~~/server/core/listenbrainzAccounts";

defineRouteMeta({
    openAPI: {
        description: "Connect a ListenBrainz account with its user token (listenbrainz.org/settings): Nafyn checks it with ListenBrainz, keeps it and starts scrobbling. Connecting again replaces the account",
        tags: ["user"],
        operationId: "connectListenBrainz",
        requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string", description: "The ListenBrainz user token" } } } } }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/ListenBrainzConnection" } } } },
            "400": { description: "Missing token, or ListenBrainz says it is not valid", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "502": { description: "ListenBrainz couldn't be reached", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

// a ListenBrainz user token is a UUID; anything far off it is not worth a round trip
const MAX_TOKEN_LENGTH = 128;

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const body = await readBody(event).catch(() => null) as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token || token.length > MAX_TOKEN_LENGTH) throw createError({ statusCode: 400, statusMessage: "token is required" });

    let account;
    try {
        account = await connectListenBrainz(userId, token);
    } catch (error) {
        console.error("[listenbrainz] connecting failed:", error instanceof Error ? error.message : error);
        throw createError({ statusCode: 502, statusMessage: "ListenBrainz couldn't be reached" });
    }
    if (!account) throw createError({ statusCode: 400, statusMessage: "ListenBrainz doesn't accept this token" });
    return { username: account.username, scrobbling: account.scrobbling };
});
