// invite a member, owner-only
import { getPlaylistById, isMember, addMember } from "~~/server/core/playlists";
import { getUserByUsername } from "~~/server/core/users";

defineRouteMeta({
    openAPI: {
        description: "Invite a member to a playlist by username. Owner only",
        tags: ["playlist"],
        operationId: "addPlaylistMember",
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
                        required: ["username"],
                        properties: {
                            username: { type: "string" }
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
                        schema: { $ref: "#/components/schemas/PlaylistMemberRow" }
                    }
                }
            },
            "400": {
                description: "Missing playlist ID, missing `username`, or the target user is the owner",
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
                description: "Only the playlist owner can add members",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist or user not found",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "409": {
                description: "User is already a member",
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
                    PlaylistMemberRow: {
                        type: "object",
                        required: ["id", "playlistId", "userId", "addedAt"],
                        properties: {
                            id: { type: "string" },
                            playlistId: { type: "string" },
                            userId: { type: "string" },
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

    if (playlist.ownerId !== userId) {
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can add members" });
    }

    const body = await readBody(event);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    if (!username) {
        throw createError({ statusCode: 400, statusMessage: "Missing `username`" });
    }

    const targetUser = await getUserByUsername(username);
    if (!targetUser) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }
    const targetUserId = targetUser.id;

    if (targetUserId === playlist.ownerId) {
        throw createError({ statusCode: 400, statusMessage: "The owner is already part of the playlist" });
    }

    if (await isMember(pid, targetUserId)) {
        throw createError({ statusCode: 409, statusMessage: "User is already a member" });
    }

    return await addMember(pid, targetUserId);
});
