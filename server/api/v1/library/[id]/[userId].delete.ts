// removes a specific user's library entry for a track; only MANAGE_MUSIC (managing someone else) or the owner themselves
import { deleteLibraryEntryForUser } from "~~/server/core/library";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

export default defineEventHandler(async (event) => {
    const { sub: actorId } = requireAuthToken(event);

    const mediaId = getRouterParam(event, "id");
    const targetUserId = getRouterParam(event, "userId");
    if (!mediaId || !targetUserId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media or user ID" });
    }

    if (targetUserId !== actorId && !hasPermission(getPermissionsById(actorId) ?? 0, Permission.MANAGE_MUSIC)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const { removed, fileDeleted } = await deleteLibraryEntryForUser(targetUserId, mediaId);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in that user's library" });
    }

    return { removed, fileDeleted };
});
