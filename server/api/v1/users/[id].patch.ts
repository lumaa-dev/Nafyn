import { getUserById, updateUser, getPermissionsById, isUsernameTaken } from "~~/server/core/users";
import { canManageUser, Permission } from "~~/server/entity/Permission";
import { assertValidUsername } from "~~/server/utils/validation";
import type { NafynUser } from "~~/server/entity/NafynUser";

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
    const actorPerms = getPermissionsById(actorId) ?? 0;

    const targetId = getRouterParam(event, "id");
    if (!targetId) {
        throw createError({ statusCode: 400, statusMessage: "Missing user ID" });
    }

    const target = getUserById(targetId);
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
        if (username !== target.username && isUsernameTaken(username)) {
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

    return updateUser(targetId, changes);
});
