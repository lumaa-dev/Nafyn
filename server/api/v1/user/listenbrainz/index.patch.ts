import { getListenBrainzAccount, setListenBrainzScrobbling } from "~~/server/core/listenbrainzAccounts";

defineRouteMeta({
    openAPI: {
        description: "Pause or resume scrobbling to the connected ListenBrainz account",
        tags: ["user"],
        operationId: "updateListenBrainzConnection",
        requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["scrobbling"], properties: { scrobbling: { type: "boolean" } } } } }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/ListenBrainzConnection" } } } },
            "400": { description: "Missing `scrobbling`", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No ListenBrainz account connected", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const body = await readBody(event).catch(() => null) as { scrobbling?: unknown } | null;
    if (typeof body?.scrobbling !== "boolean") throw createError({ statusCode: 400, statusMessage: "scrobbling must be a boolean" });

    if (!await setListenBrainzScrobbling(userId, body.scrobbling)) throw createError({ statusCode: 404, statusMessage: "No ListenBrainz account connected" });
    const account = await getListenBrainzAccount(userId);
    return { username: account?.username ?? null, scrobbling: !!account?.scrobbling };
});
