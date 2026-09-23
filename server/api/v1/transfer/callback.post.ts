import { getTransferProvider } from "~~/server/utils/transfer/providers";
import { consumePendingAuth, createTransferSession } from "~~/server/utils/transfer/sessions";
import { requireImportPermission } from "~~/server/utils/transfer/access";

defineRouteMeta({
    openAPI: {
        description: "Finish connecting a streaming account: exchange the authorization code the provider redirected back with. Returns a short-lived, in-memory import session (the provider token itself never leaves the server)",
        tags: ["transfer"],
        operationId: "finishTransferConnect",
        requestBody: {
            content: { "application/json": { schema: { type: "object", required: ["state", "code"], properties: { state: { type: "string" }, code: { type: "string" } } } } }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", required: ["sessionId", "provider"], properties: { sessionId: { type: "string" }, provider: { type: "string" } } } } } },
            "400": { description: "Unknown, expired or already used state", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "502": { description: "The provider refused the code", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    await requireImportPermission(userId);

    const body = await readBody(event);
    const state = typeof body?.state === "string" ? body.state : null;
    const code = typeof body?.code === "string" ? body.code : null;
    if (!state || !code || code.length > 2048) {
        throw createError({ statusCode: 400, statusMessage: "Malformed request" });
    }

    const pending = consumePendingAuth(state, userId);
    const provider = pending ? getTransferProvider(pending.provider) : null;
    if (!pending || !provider?.exchangeCode) {
        throw createError({ statusCode: 400, statusMessage: "This sign-in link has expired, please connect again" });
    }

    let session;
    try {
        const tokens = await provider.exchangeCode({ code, redirectUri: pending.redirectUri, codeVerifier: pending.codeVerifier, state });
        session = createTransferSession(userId, provider.id, tokens.accessToken, tokens.expiresIn);
        await provider.init?.(session);
    } catch (err) {
        console.error(`[transfer] ${provider.id} sign-in failed:`, err);
        throw createError({ statusCode: 502, statusMessage: "The service refused the sign-in, please try again" });
    }

    return { sessionId: session.id, provider: provider.id };
});
