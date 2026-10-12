import { randomUUID } from "node:crypto";
import { generateAuthenticationOptions, rpIdFromEvent } from "~~/server/utils/webauthn";
import { putLoginChallenge } from "~~/server/utils/passkeyChallenges";
import { consumeRateLimit, isWhitelisted } from "~~/server/utils/rateLimit";
import { getClientIP } from "~~/server/utils/clientIp";

const MAX_ATTEMPTS_PER_IP = 20;
const WINDOW_MS = 15 * 60 * 1000;

defineRouteMeta({
    openAPI: {
        description: "Start a passkey login: returns options to pass into the browser's navigator.credentials.get(), plus a challengeId to send back to /login. No username needed - the credential is discoverable.",
        tags: ["auth"],
        operationId: "getPasskeyLoginOptions",
        responses: {
            "200": { description: "" },
            "429": {
                description: "Rate limit error",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const ip = getClientIP(event);

    if (!await isWhitelisted(ip)) {
        const rateLimit = consumeRateLimit(`passkey-login-options:${ip}`, MAX_ATTEMPTS_PER_IP, WINDOW_MS);
        if (!rateLimit.allowed) {
            setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
            throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
        }
    }

    // no allowCredentials: an empty list is what tells the browser to show every discoverable passkey it
    // holds for this rpID rather than needing a username up front
    const options = await generateAuthenticationOptions({
        rpID: rpIdFromEvent(event),
        userVerification: "preferred"
    });

    const challengeId = randomUUID();
    putLoginChallenge(challengeId, options.challenge);

    return { challengeId, options };
});
