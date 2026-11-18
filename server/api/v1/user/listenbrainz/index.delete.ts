import { deleteListenBrainzAccount } from "~~/server/core/listenbrainzAccounts";

defineRouteMeta({
    openAPI: {
        description: "Disconnect the ListenBrainz account: Nafyn forgets its token and stops scrobbling. (The token itself stays valid until reset on listenbrainz.org.)",
        tags: ["user"],
        operationId: "disconnectListenBrainz",
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", properties: { removed: { type: "boolean" } } } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    return { removed: await deleteListenBrainzAccount(userId) };
});
