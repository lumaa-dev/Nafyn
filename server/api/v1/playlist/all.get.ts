// every playlist regardless of owner/membership, for MANAGE_MUSIC users managing tracks from the everyone's-library page
import { getLibrariesDb } from "~~/server/core/db";
import type { PlaylistRow } from "~~/server/core/playlists";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "List every playlist regardless of owner/membership. Requires MANAGE_MUSIC",
        tags: ["playlist"],
        operationId: "getAllPlaylists",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/PlaylistRow" }
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

    return await getLibrariesDb().prepare(`SELECT * FROM playlists ORDER BY updatedAt DESC`).all() as PlaylistRow[];
});
