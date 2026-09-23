import { getTransferProvider } from "~~/server/utils/transfer/providers";
import { createTransferSession, dropTransferSession } from "~~/server/utils/transfer/sessions";
import { resolveDeezerProfile } from "~~/server/utils/transfer/providers/deezer";
import { requireImportPermission } from "~~/server/utils/transfer/access";

defineRouteMeta({
    openAPI: {
        description: "Connect a streaming account without an OAuth redirect: Apple Music (with the Music User Token MusicKit on the Web returned in the browser) or a public Deezer profile (by link or numeric id)",
        tags: ["transfer"],
        operationId: "createTransferSession",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["provider"],
                        properties: {
                            provider: { type: "string", enum: ["apple", "deezer"] },
                            musicUserToken: { type: "string", description: "Apple Music only" },
                            profile: { type: "string", description: "Deezer only: profile URL, share link or numeric user id" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", required: ["sessionId", "provider"], properties: { sessionId: { type: "string" }, provider: { type: "string" } } } } } },
            "400": { description: "Missing token/profile, or a profile that couldn't be read", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "503": { description: "Apple Music isn't set up on this server", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    await requireImportPermission(userId);

    const body = await readBody(event);
    const provider = getTransferProvider(body?.provider);

    if (provider?.id === "apple") {
        if (!provider.isConfigured()) throw createError({ statusCode: 503, statusMessage: "Apple Music isn't set up on this server" });
        const token = typeof body?.musicUserToken === "string" ? body.musicUserToken.trim() : "";
        if (!token || token.length > 4096) throw createError({ statusCode: 400, statusMessage: "Missing Apple Music authorization" });

        const session = createTransferSession(userId, "apple", token, null);
        try {
            await provider.init?.(session);
        } catch (err) {
            dropTransferSession(session.id);
            console.error("[transfer] apple sign-in failed:", err);
            throw createError({ statusCode: 400, statusMessage: "Apple Music refused the authorization, please try again" });
        }
        return { sessionId: session.id, provider: "apple" };
    }

    if (provider?.id === "deezer") {
        const input = typeof body?.profile === "string" ? body.profile.slice(0, 500) : "";
        const userRef = input ? await resolveDeezerProfile(input) : null;
        if (!userRef) throw createError({ statusCode: 400, statusMessage: "That doesn't look like a Deezer profile link" });

        const session = createTransferSession(userId, "deezer", null, null, { userRef });
        try {
            await provider.init?.(session);
        } catch {
            dropTransferSession(session.id);
            throw createError({ statusCode: 400, statusMessage: "That Deezer profile couldn't be read - is it public?" });
        }
        return { sessionId: session.id, provider: "deezer" };
    }

    throw createError({ statusCode: 400, statusMessage: "This service can't be connected that way" });
});
