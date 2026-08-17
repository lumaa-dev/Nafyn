// remove a member, owner-only (members leave voluntarily via /leave instead)
import { getPlaylistById, removeMember } from "~~/server/core/playlists";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const pid = getRouterParam(event, "pid");
    const uid = getRouterParam(event, "uid");
    if (!pid || !uid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist or user ID" });
    }

    const playlist = getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    if (playlist.ownerId !== userId) {
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can remove members" });
    }

    const removed = removeMember(pid, uid);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "Member not found" });
    }

    return { removed: true };
});
