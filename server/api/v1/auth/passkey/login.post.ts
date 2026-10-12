import { randomUUID } from "node:crypto";
import { verifyAuthenticationResponse, rpIdFromEvent, originFromEvent } from "~~/server/utils/webauthn";
import { takeLoginChallenge } from "~~/server/utils/passkeyChallenges";
import { getPasskeyByCredentialId, updatePasskeyCounter } from "~~/server/core/passkeys";
import { getUserById } from "~~/server/core/users";
import { consumeRateLimit, isWhitelisted } from "~~/server/utils/rateLimit";
import { getClientIP } from "~~/server/utils/clientIp";
import { signAuthToken } from "~~/server/utils/jwt";
import { createSession } from "~~/server/core/sessions";

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // mirrors signAuthToken's own "7d" expiresIn
const MAX_ATTEMPTS_PER_IP = 20;
const WINDOW_MS = 15 * 60 * 1000;

defineRouteMeta({
    openAPI: {
        description: "Finish a passkey login: verifies the browser's navigator.credentials.get() response against the challenge from /login-options and, if valid, logs the owning user in",
        tags: ["auth"],
        operationId: "passkeyLogin",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["challengeId", "response"],
                        properties: {
                            challengeId: { type: "string" },
                            response: { type: "object", description: "AuthenticationResponseJSON from @simplewebauthn/browser's startAuthentication()" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            properties: {
                                user: { $ref: "#/components/schemas/NafynUser" },
                                token: { type: "string" }
                            },
                            required: ["user", "token"]
                        }
                    }
                }
            },
            "400": {
                description: "Missing/expired challenge, unknown credential, or failed verification",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "429": {
                description: "Rate limit error",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const body = await readBody(event).catch(() => null);
    const challengeId = typeof body?.challengeId === "string" ? body.challengeId : "";
    if (!challengeId || !body?.response) {
        throw createError({ statusCode: 400, statusMessage: "Missing challengeId or response" });
    }

    const ip = getClientIP(event);
    if (!await isWhitelisted(ip)) {
        const rateLimit = consumeRateLimit(`passkey-login:${ip}`, MAX_ATTEMPTS_PER_IP, WINDOW_MS);
        if (!rateLimit.allowed) {
            setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
            throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
        }
    }

    const expectedChallenge = takeLoginChallenge(challengeId);
    if (!expectedChallenge) {
        throw createError({ statusCode: 400, statusMessage: "Login challenge expired, try again" });
    }

    const credentialId = typeof body.response.id === "string" ? body.response.id : "";
    const passkey = credentialId ? await getPasskeyByCredentialId(credentialId) : null;
    if (!passkey) {
        throw createError({ statusCode: 400, statusMessage: "Unknown passkey" });
    }

    const verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge,
        expectedOrigin: originFromEvent(event),
        expectedRPID: rpIdFromEvent(event),
        credential: {
            id: passkey.credentialId,
            publicKey: Buffer.from(passkey.publicKey, "base64"),
            counter: passkey.counter,
            transports: passkey.transports ? passkey.transports.split(",") : undefined
        },
        // login-options.post.ts asks for userVerification: "preferred", not "required" - must match (see the
        // same note in passkeys/register.post.ts)
        requireUserVerification: false
    }).catch((err) => {
        console.error("[passkeys] login verification failed:", err);
        return null;
    });

    if (!verification?.verified) {
        throw createError({ statusCode: 400, statusMessage: "Could not verify passkey" });
    }

    const { newCounter } = verification.authenticationInfo;
    // many platform authenticators (Apple's among them) never increment past 0 - the counter is only a
    // clone-detection signal when the authenticator actually uses it, so a real regression (nonzero stored
    // counter that didn't increase) is rejected, while "both zero" is left alone
    if (passkey.counter !== 0 && newCounter <= passkey.counter) {
        throw createError({ statusCode: 400, statusMessage: "Could not verify passkey" });
    }

    const user = await getUserById(passkey.userId);
    if (!user) {
        throw createError({ statusCode: 400, statusMessage: "Could not verify passkey" });
    }

    await updatePasskeyCounter(passkey.id, newCounter);

    const jti = randomUUID();
    await createSession(user.id, jti, getHeader(event, "user-agent") ?? null, ip, Date.now() + SESSION_LIFETIME_MS);
    const token = signAuthToken(user.id, jti);

    return { user, token };
});
