import { getPlaylistById, updatePlaylist } from "~~/server/core/playlists";
import { deletePlaylistImage } from "~~/server/utils/playlistImage";

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
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can remove its image" });
    }

    await deletePlaylistImage(pid);

    return updatePlaylist(pid, { image: null });
});
