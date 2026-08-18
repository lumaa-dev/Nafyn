import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { getTotalMediaSize, getStorageByUser } from "~~/server/core/library";
import { listUsers, getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "Disk and per-user storage usage stats for the `music` directory. Requires MANAGE_MUSIC",
        tags: ["settings"],
        operationId: "getStorage",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["totalBytes", "freeBytes", "usedByNafynBytes", "perUser"],
                            properties: {
                                totalBytes: { type: "number", description: "Total capacity of the filesystem hosting `music/`" },
                                freeBytes: { type: "number", description: "Free space available on that filesystem" },
                                usedByNafynBytes: { type: "number", description: "Combined size of every distinct media file Nafyn manages" },
                                perUser: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        required: ["userId", "username", "displayName", "bytes"],
                                        properties: {
                                            userId: { type: "string" },
                                            username: { type: "string" },
                                            displayName: { type: "string", nullable: true },
                                            bytes: { type: "number", description: "Bytes owned by this user (shared tracks count for each owner)" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "401": {
                description: "Not authenticated, or missing MANAGE_MUSIC permission",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const stats = await statfs(join(process.cwd(), "music"));
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedByNafynBytes = await getTotalMediaSize();

    const users = new Map((await listUsers()).map((u) => [u.id, u]));
    const perUser = (await getStorageByUser()).map((row) => {
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
