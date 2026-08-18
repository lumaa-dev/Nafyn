// every media row across every user's library, view-only for MANAGE_MUSIC users (streaming still enforces per-owner access)
import { getAllMediaWithOwners } from "~~/server/core/library";
import { listUsers, getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    if (!hasPermission(getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const users = new Map(listUsers().map((u) => [u.id, u]));

    return getAllMediaWithOwners().map(({ ownerIds, ...media }) => ({
        ...media,
        owners: ownerIds.map((id) => ({ userId: id, username: users.get(id)?.username ?? "unknown" }))
    }));
});
