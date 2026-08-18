// removes a single entry; members may only remove entries they personally added, the owner can remove any entry,
// and MANAGE_MUSIC users can remove any entry from any playlist
import { getPlaylistById, getEntryById, removeEntry } from "~~/server/core/playlists";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "Remove a single entry from a playlist. Members may only remove entries they personally added; the owner can remove any entry; MANAGE_MUSIC users can remove any entry from any playlist",
        tags: ["playlist"],
        operationId: "removePlaylistTrack",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            },
            {
                name: "eid",
                in: "path",
                required: true,
                description: "Playlist entry ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["removed"],
                            properties: {
                                removed: { type: "boolean" }
                            }
                        }
                    }
                }
            },
            "400": {
                description: "Missing playlist or entry ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "403": {
                description: "You can only remove tracks you added",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist or entry not found",
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

    const pid = getRouterParam(event, "pid");
    const eid = getRouterParam(event, "eid");
    if (!pid || !eid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist or entry ID" });
    }

    const playlist = await getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    const entry = await getEntryById(eid);
    if (!entry || entry.playlistId !== pid) {
        throw createError({ statusCode: 404, statusMessage: "Entry not found" });
    }

    const isOwner = playlist.ownerId === userId;
    const isAdder = entry.addedBy === userId;
    const canManageMusic = hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC);
    if (!isOwner && !isAdder && !canManageMusic) {
        throw createError({ statusCode: 403, statusMessage: "You can only remove tracks you added" });
    }

    await removeEntry(eid);

    return { removed: true };
});
