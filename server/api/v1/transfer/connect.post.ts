import { getTransferProvider } from "~~/server/utils/transfer/providers";
import { createPendingAuth, transferRedirectUri } from "~~/server/utils/transfer/sessions";
import { requireImportPermission } from "~~/server/utils/transfer/access";
import type { TransferProviderId } from "~~/server/entity/Transfer";

defineRouteMeta({
    openAPI: {
        description: "Start connecting a streaming account over OAuth. Returns the provider's sign-in URL to send the browser to; the provider then redirects back to /transfer/callback",
        tags: ["transfer"],
        operationId: "connectTransferProvider",
        requestBody: {
            content: { "application/json": { schema: { type: "object", required: ["provider"], properties: { provider: { type: "string" } } } } }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } } },
            "400": { description: "Unknown provider, or one that doesn't sign in over OAuth", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "Missing REQUEST_TRACKS and REQUEST_ALBUMS", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "503": { description: "The server has no developer credentials for that provider", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    await requireImportPermission(userId);

    const body = await readBody(event);
    const provider = getTransferProvider(body?.provider);
    if (!provider || !provider.authModes().includes("oauth") || !provider.authorizeUrl) {
        throw createError({ statusCode: 400, statusMessage: "This service can't be connected that way" });
    }
    if (!provider.isConfigured()) {
        throw createError({ statusCode: 503, statusMessage: "This service isn't set up on this server" });
    }

    const redirectUri = transferRedirectUri(event);
    const { state, codeChallenge } = createPendingAuth(userId, provider.id as TransferProviderId, redirectUri);
    return { url: provider.authorizeUrl({ state, redirectUri, codeChallenge }) };
});
