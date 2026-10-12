import { getUserById } from "~~/server/core/users";
import { listCredentialIdsForUser, countPasskeysForUser } from "~~/server/core/passkeys";
import { generateRegistrationOptions, rpIdFromEvent, RP_NAME } from "~~/server/utils/webauthn";
import { putRegistrationChallenge } from "~~/server/utils/passkeyChallenges";

const MAX_PASSKEYS_PER_USER = 10;

defineRouteMeta({
    openAPI: {
        description: "Start registering a new passkey for the currently authenticated user: returns options to pass into the browser's navigator.credentials.create()",
        tags: ["user"],
        operationId: "getMyPasskeyRegistrationOptions",
        responses: {
            "200": { description: "" },
            "400": {
                description: "Passkey limit reached",
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

    if (await countPasskeysForUser(userId) >= MAX_PASSKEYS_PER_USER) {
        throw createError({ statusCode: 400, statusMessage: `At most ${MAX_PASSKEYS_PER_USER} passkeys - remove one first` });
    }

    const user = await getUserById(userId);
    if (!user) {
        throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
    }

    const existingCredentialIds = await listCredentialIdsForUser(userId);

    const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rpIdFromEvent(event),
        userName: user.username,
        userDisplayName: user.displayName ?? user.username,
        // lets the authenticator skip offering a credential this account already has registered
        excludeCredentials: existingCredentialIds.map((id) => ({ id })),
        // residentKey "required" (rather than the library default "preferred") is what makes the credential
        // discoverable, which is what lets the login flow ask "who are you?" without the user typing a
        // username first
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        attestationType: "none"
    });

    putRegistrationChallenge(userId, options.challenge);

    return options;
});
