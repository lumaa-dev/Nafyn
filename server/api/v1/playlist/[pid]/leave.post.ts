// a member voluntarily leaves; tracks they added stay in the playlist
import { getPlaylistById, removeMember } from "~~/server/core/playlists";

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

    if (playlist.ownerId === userId) {
        throw createError({ statusCode: 400, statusMessage: "The owner can't leave their own playlist, delete it instead" });
    }

    const removed = removeMember(pid, userId);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "You're not a member of this playlist" });
    }

    return { removed: true };
});
