import { getPlaylistsForUser } from "~~/server/core/playlists";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    return getPlaylistsForUser(userId);
});
