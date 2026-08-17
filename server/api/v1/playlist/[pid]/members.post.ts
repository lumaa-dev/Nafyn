// invite a member, owner-only
import { getPlaylistById, isMember, addMember } from "~~/server/core/playlists";
import { getUserByUsername } from "~~/server/core/users";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = getPlaylistById(pid);
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

    const targetUser = getUserByUsername(username);
    if (!targetUser) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }
    const targetUserId = targetUser.id;

    if (targetUserId === playlist.ownerId) {
        throw createError({ statusCode: 400, statusMessage: "The owner is already part of the playlist" });
    }

    if (isMember(pid, targetUserId)) {
        throw createError({ statusCode: 409, statusMessage: "User is already a member" });
    }

    return addMember(pid, targetUserId);
});
