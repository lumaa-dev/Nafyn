// remove a member, owner-only (members leave voluntarily via /leave instead)
import { getPlaylistById, removeMember } from "~~/server/core/playlists";

defineRouteMeta({
    openAPI: {
        description: "Remove a member from a playlist. Owner only (members leave voluntarily via POST /playlist/{pid}/leave instead)",
        tags: ["playlist"],
        operationId: "removePlaylistMember",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            },
            {
                name: "uid",
                in: "path",
                required: true,
                description: "ID of the member to remove",
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
                description: "Missing playlist or user ID",
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
                description: "Only the playlist owner can remove members",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist not found, or member not found",
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
    const uid = getRouterParam(event, "uid");
    if (!pid || !uid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist or user ID" });
    }

    const playlist = await getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    if (playlist.ownerId !== userId) {
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can remove members" });
    }

    const removed = await removeMember(pid, uid);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "Member not found" });
    }

    return { removed: true };
});
