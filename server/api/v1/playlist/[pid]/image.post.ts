import { getPlaylistById, updatePlaylist } from "~~/server/core/playlists";
import { savePlaylistImage } from "~~/server/utils/playlistImage";

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
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can change its image" });
    }

    const form = await readMultipartFormData(event);
    const file = form?.find((part) => part.name === "image");
    if (!file?.data?.length) {
        throw createError({ statusCode: 400, statusMessage: "Missing `image` file" });
    }

    await savePlaylistImage(pid, file.data);

    // cache-busting token for clients building the image URL, actual bytes are always at the same path
    return updatePlaylist(pid, { image: Date.now().toString() });
});
