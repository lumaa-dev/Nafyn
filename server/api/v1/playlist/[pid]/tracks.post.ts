// adds one or more tracks to a playlist (single track = 1-length array, full album/EP = the album's track IDs); owner or member only.
// entries reference `media.id` directly, not `library_entries`, so a member can add a track they don't personally own.
import { getPlaylistById, hasAccess, addEntries } from "~~/server/core/playlists";
import { getMediaId } from "~~/server/core/library";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "Add one or more tracks to a playlist (single track = 1-length array, full album/EP = the album's track IDs). Owner, invited member, or a MANAGE_MUSIC user",
        tags: ["playlist"],
        operationId: "addPlaylistTracks",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            }
        ],
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["mediaIds"],
                        properties: {
                            mediaIds: {
                                type: "array",
                                description: "Non-empty array of media IDs to append",
                                items: { type: "string" }
                            }
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
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/PlaylistEntryRow" }
                        }
                    }
                }
            },
            "400": {
                description: "Missing playlist ID, or `mediaIds` isn't a non-empty array of strings",
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
                description: "You don't have access to this playlist",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist not found, or one of the given media IDs doesn't exist",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        },
        $global: {
            components: {
                schemas: {
                    PlaylistEntryRow: {
                        type: "object",
                        required: ["id", "playlistId", "mediaId", "addedBy", "position", "addedAt"],
                        properties: {
                            id: { type: "string" },
                            playlistId: { type: "string" },
                            mediaId: { type: "string" },
                            addedBy: { type: "string", description: "User ID who added this entry" },
                            position: { type: "number" },
                            addedAt: { type: "number", description: "Unix timestamp (milliseconds)" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = await getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    const canManageMusic = hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC);
    if (playlist.ownerId !== userId && !await hasAccess(playlist, userId) && !canManageMusic) {
        throw createError({ statusCode: 403, statusMessage: "You don't have access to this playlist" });
    }

    const body = await readBody(event);
    const mediaIds: unknown = body?.mediaIds;
    if (!Array.isArray(mediaIds) || mediaIds.length === 0 || !mediaIds.every((id) => typeof id === "string")) {
        throw createError({ statusCode: 400, statusMessage: "`mediaIds` must be a non-empty array of media IDs" });
    }

    for (const mediaId of mediaIds) {
        if (!await getMediaId(mediaId)) {
            throw createError({ statusCode: 404, statusMessage: `Media ${mediaId} not found` });
        }
    }

    return await addEntries(pid, mediaIds, userId);
});
