import { getUserById, deleteUser, getPermissionsById } from "~~/server/core/users";
import { deleteAllLibraryEntriesForUser } from "~~/server/core/library";
import { canManageUser } from "~~/server/entity/Permission";

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

    await deleteAllLibraryEntriesForUser(targetId);
    const removed = deleteUser(targetId);

    return { removed };
});
