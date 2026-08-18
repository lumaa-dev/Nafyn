// every playlist regardless of owner/membership, for MANAGE_MUSIC users managing tracks from the everyone's-library page
import { getLibrariesDb } from "~~/server/core/db";
import type { PlaylistRow } from "~~/server/core/playlists";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    if (!hasPermission(getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    return getLibrariesDb().prepare(`SELECT * FROM playlists ORDER BY updatedAt DESC`).all() as PlaylistRow[];
});
