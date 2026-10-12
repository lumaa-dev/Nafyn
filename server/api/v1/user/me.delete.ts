// GDPR art. 17: self-service account deletion. Until this existed, erasure went through an administrator
// (DELETE /api/v1/users/{id}), which makes the right to erasure dependent on somebody else acting - fine as
// an operational tool, not as the only way out.
//
// Re-authentication is required (password, or any valid api_tokens secret for a client that only has one):
// account deletion is irreversible and a stolen JWT must not be enough to trigger it.
import bcrypt from "bcrypt";
import { getUserById, getPasswordHash, getPermissionsById, countAdmins, countUsers } from "~~/server/core/users";
import { findApiTokenBySecret } from "~~/server/core/apiTokens";
import { eraseAccount } from "~~/server/core/accountErasure";
import { Permission } from "~~/server/entity/Permission";
import { consumeRateLimit, resetRateLimit } from "~~/server/utils/rateLimit";

// same dummy hash trick as login: bcrypt.compare always runs, so a wrong password and a missing account
// take the same time
const DUMMY_HASH = bcrypt.hashSync("LumaaDev-Nafyn-Password", 12);
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

defineRouteMeta({
    openAPI: {
        description: "Permanently erase the requesting user's own account and every piece of data attached to it. Requires re-authentication with the account's password (or one of its API tokens). Irreversible.",
        tags: ["user"],
        operationId: "deleteOwnAccount",
        requestBody: {
            required: true,
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            password: { type: "string", description: "The account's current password, or one of its API tokens" }
                        },
                        required: ["password"]
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
                            required: ["removed"],
                            properties: {
                                removed: { type: "boolean" },
                                erased: { type: "object", description: "Per-area count of what was removed" }
                            }
                        }
                    }
                }
            },
            "400": { description: "Missing password", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated, or the password is wrong", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "The account is the instance's last administrator and other accounts still exist", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many attempts", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const body = await readBody(event).catch(() => null);
    const password = typeof body?.password === "string" ? body.password : "";
    if (!password) {
        throw createError({ statusCode: 400, statusMessage: "Missing password" });
    }

    const rateLimitKey = `account-delete:${userId}`;
    const rateLimit = consumeRateLimit(rateLimitKey, MAX_ATTEMPTS, WINDOW_MS);
    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many attempts, try again later" });
    }

    const user = await getUserById(userId);
    if (!user) {
        throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
    }

    const hash = await getPasswordHash(user.username);
    let valid = await bcrypt.compare(password, hash ?? DUMMY_HASH);

    // a Subsonic-only client has an app password and nothing else; accept that as re-authentication, but
    // only when the token actually belongs to this account
    if (!valid) {
        const tokenRow = await findApiTokenBySecret(password);
        valid = !!tokenRow && tokenRow.userId === userId;
    }

    if (!valid) {
        throw createError({ statusCode: 401, statusMessage: "Invalid password" });
    }

    resetRateLimit(rateLimitKey);

    // SECURITY/operational guard, not a GDPR exception: an instance with other users on it but no remaining
    // administrator can never be administered again. The last admin has to pass ADMIN on first. A sole
    // account (nobody else to hand it to) is always allowed to delete itself - the instance just goes back
    // to its first-registration-bootstraps-admin state.
    const permissions = await getPermissionsById(userId) ?? 0;
    if ((permissions & Permission.ADMIN) && await countAdmins() <= 1 && await countUsers() > 1) {
        throw createError({
            statusCode: 409,
            statusMessage: "You are the only administrator. Grant ADMIN to another account before deleting yours."
        });
    }

    const erased = await eraseAccount(userId);

    return { removed: erased.removed, erased };
});
