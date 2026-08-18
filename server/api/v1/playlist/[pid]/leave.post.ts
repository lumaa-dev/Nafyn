// a member voluntarily leaves; tracks they added stay in the playlist
import { getPlaylistById, removeMember } from "~~/server/core/playlists";

defineRouteMeta({
    openAPI: {
        description: "Voluntarily leave a playlist you're a member of. Tracks you added stay in the playlist. The owner can't leave their own playlist (delete it instead)",
        tags: ["playlist"],
        operationId: "leavePlaylist",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
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
                description: "Missing playlist ID, or the owner tried to leave their own playlist",
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
            "404": {
                description: "Playlist not found, or you're not a member of it",
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
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = await getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    if (playlist.ownerId === userId) {
        throw createError({ statusCode: 400, statusMessage: "The owner can't leave their own playlist, delete it instead" });
    }

    const removed = await removeMember(pid, userId);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "You're not a member of this playlist" });
    }

    return { removed: true };
});
