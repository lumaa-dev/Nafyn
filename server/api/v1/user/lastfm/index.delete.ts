import { deleteLastfmAccount } from "~~/server/core/lastfmAccounts";

defineRouteMeta({
    openAPI: {
        description: "Disconnect the Last.fm account: Nafyn forgets its session key and stops scrobbling. (The access stays listed under the Last.fm account's own settings until removed there.)",
        tags: ["user"],
        operationId: "disconnectLastfm",
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", properties: { removed: { type: "boolean" } } } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    return { removed: await deleteLastfmAccount(userId) };
});
