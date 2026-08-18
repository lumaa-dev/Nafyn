import { getUserById, updateUser, getPermissionsById, isUsernameTaken } from "~~/server/core/users";
import { canManageUser, Permission } from "~~/server/entity/Permission";
import { assertValidUsername } from "~~/server/utils/validation";
import type { NafynUser } from "~~/server/entity/NafynUser";

defineRouteMeta({
    openAPI: {
        description: "Update another user's account fields, including permissions. Requires ADMIN, or MANAGE_ACCOUNTS against a non-privileged target (see canManageUser). Only an ADMIN can grant/revoke MANAGE_ACCOUNTS or ADMIN itself",
        tags: ["users"],
        operationId: "updateUser",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Target user ID",
                schema: { type: "string" }
            }
        ],
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            displayName: { type: "string", description: "1-20 characters" },
                            username: { type: "string" },
                            lastFm: { type: "string", nullable: true, description: "Up to 50 characters" },
                            discogs: { type: "string", nullable: true, description: "Up to 50 characters" },
                            permissions: { type: "number", description: "Non-negative integer bitfield, see the Permission enum" }
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
                        schema: { $ref: "#/components/schemas/NafynUser" }
                    }
                }
            },
            "400": {
                description: "Missing user ID, invalid field value, username taken, or no changes provided",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated, or insufficient permissions to manage this user",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "User not found",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "409": {
                description: "Username is already taken",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") {
        throw createError({ statusCode: 400, statusMessage: "Must be a string or null" });
    }

    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        throw createError({ statusCode: 400, statusMessage: `Must be ${maxLength} characters or fewer` });
    }

    return trimmed.length ? trimmed : null;
}

export default defineEventHandler(async (event) => {
    const { sub: actorId } = requireAuthToken(event);
    const actorPerms = await getPermissionsById(actorId) ?? 0;

    const targetId = getRouterParam(event, "id");
    if (!targetId) {
        throw createError({ statusCode: 400, statusMessage: "Missing user ID" });
    }

    const target = await getUserById(targetId);
    if (!target) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    if (!canManageUser(actorId, actorPerms, targetId, target.permissions as unknown as number)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const body = await readBody(event);
    const changes: Partial<Pick<NafynUser, "displayName" | "username" | "lastFm" | "discogs" | "permissions">> = {};

    if ("displayName" in body) {
        const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
        if (displayName.length < 1 || displayName.length > 20) {
            throw createError({ statusCode: 400, statusMessage: "displayName must be between 1 and 20 characters" });
        }
        changes.displayName = displayName;
    }

    if ("username" in body) {
        const username = typeof body.username === "string" ? body.username.trim() : "";
        assertValidUsername(username);
        if (username !== target.username && await isUsernameTaken(username)) {
            throw createError({ statusCode: 409, statusMessage: "Username is already taken" });
        }
        (changes as Partial<NafynUser>).username = username;
    }

    if ("lastFm" in body) {
        changes.lastFm = normalizeOptionalText(body.lastFm, 50);
    }

    if ("discogs" in body) {
        changes.discogs = normalizeOptionalText(body.discogs, 50);
    }

    if ("permissions" in body) {
        const permissions = body.permissions;
        if (typeof permissions !== "number" || !Number.isInteger(permissions) || permissions < 0) {
            throw createError({ statusCode: 400, statusMessage: "permissions must be a non-negative integer" });
        }

        const escalationBits = Permission.MANAGE_ACCOUNTS | Permission.ADMIN;
        const isAdmin = !!(actorPerms & Permission.ADMIN);
        if (!isAdmin && (permissions & escalationBits) !== ((target.permissions as unknown as number) & escalationBits)) {
            throw createError({ statusCode: 400, statusMessage: "Only an ADMIN can grant or revoke MANAGE_ACCOUNTS/ADMIN" });
        }

        changes.permissions = permissions;
    }

    if (Object.keys(changes).length === 0) {
        throw createError({ statusCode: 400, statusMessage: "No changes provided" });
    }

    return await updateUser(targetId, changes);
});
