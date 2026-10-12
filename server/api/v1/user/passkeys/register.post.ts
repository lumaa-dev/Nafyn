import { verifyRegistrationResponse, rpIdFromEvent, originFromEvent } from "~~/server/utils/webauthn";
import { takeRegistrationChallenge } from "~~/server/utils/passkeyChallenges";
import { createPasskey } from "~~/server/core/passkeys";

const MAX_LABEL_LENGTH = 100;

defineRouteMeta({
    openAPI: {
        description: "Finish registering a new passkey: verifies the browser's navigator.credentials.create() response against the challenge from /register-options and stores the credential",
        tags: ["user"],
        operationId: "registerMyPasskey",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["response"],
                        properties: {
                            response: { type: "object", description: "RegistrationResponseJSON from @simplewebauthn/browser's startRegistration()" },
                            label: { type: "string", nullable: true, description: `Optional label (e.g. "iPhone"), up to ${MAX_LABEL_LENGTH} characters` }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "" },
            "400": {
                description: "Missing/expired challenge or failed verification",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "401": {
                description: "Not authenticated",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const body = await readBody(event).catch(() => null);
    if (!body?.response) {
        throw createError({ statusCode: 400, statusMessage: "Missing response" });
    }

    const rawLabel = typeof body.label === "string" ? body.label.trim() : "";
    const label = rawLabel ? rawLabel.slice(0, MAX_LABEL_LENGTH) : null;

    const expectedChallenge = takeRegistrationChallenge(userId);
    if (!expectedChallenge) {
        throw createError({ statusCode: 400, statusMessage: "Registration challenge expired, try again" });
    }

    const verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge,
        expectedOrigin: originFromEvent(event),
        expectedRPID: rpIdFromEvent(event),
        // register-options.post.ts asks for userVerification: "preferred", not "required" - this must match,
        // or an authenticator that (legitimately) skipped UV because "preferred" allowed it gets rejected
        // here anyway, since the library's own default is `true`
        requireUserVerification: false
    }).catch((err) => {
        console.error("[passkeys] registration verification failed:", err);
        return null;
    });

    if (!verification?.verified || !verification.registrationInfo) {
        throw createError({ statusCode: 400, statusMessage: "Could not verify passkey" });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const row = await createPasskey({
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64"),
        counter: credential.counter,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: credential.transports?.join(",") ?? null,
        label
    });

    const { publicKey: _publicKey, ...summary } = row;
    return summary;
});
