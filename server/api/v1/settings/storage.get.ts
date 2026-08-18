import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { getTotalMediaSize, getStorageByUser } from "~~/server/core/library";
import { listUsers, getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    if (!hasPermission(getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const stats = await statfs(join(process.cwd(), "music"));
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedByNafynBytes = getTotalMediaSize();

    const users = new Map(listUsers().map((u) => [u.id, u]));
    const perUser = getStorageByUser().map((row) => {
        const u = users.get(row.userId);
        return {
            userId: row.userId,
            username: u?.username ?? "unknown",
            displayName: u?.displayName ?? null,
            bytes: row.bytes
        };
    });

    return { totalBytes, freeBytes, usedByNafynBytes, perUser };
});
