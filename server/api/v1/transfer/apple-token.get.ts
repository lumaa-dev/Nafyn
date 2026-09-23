import { appleProvider, getAppleDeveloperToken } from "~~/server/utils/transfer/providers/apple";
import { requireImportPermission } from "~~/server/utils/transfer/access";

defineRouteMeta({
    openAPI: {
        description: "Get a short-lived Apple Music developer token, needed by MusicKit on the Web in the browser to ask the user for access to their Apple Music library",
        tags: ["transfer"],
        operationId: "getAppleMusicDeveloperToken",
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", required: ["developerToken"], properties: { developerToken: { type: "string" } } } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "503": { description: "Apple Music isn't set up on this server", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    await requireImportPermission(userId);

    if (!appleProvider.isConfigured()) {
        throw createError({ statusCode: 503, statusMessage: "Apple Music isn't set up on this server" });
    }

    try {
        return { developerToken: getAppleDeveloperToken() };
    } catch (err) {
        // almost always a malformed APPLE_MUSIC_PRIVATE_KEY
        console.error("[transfer] could not sign the Apple Music developer token:", err);
        throw createError({ statusCode: 503, statusMessage: "Apple Music isn't set up correctly on this server" });
    }
});
