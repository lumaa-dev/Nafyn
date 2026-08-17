// adds one or more tracks to a playlist (single track = 1-length array, full album/EP = the album's track IDs); owner or member only.
// entries reference `media.id` directly, not `library_entries`, so a member can add a track they don't personally own.
import { getPlaylistById, hasAccess, addEntries } from "~~/server/core/playlists";
import { getMediaId } from "~~/server/core/library";

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

    if (playlist.ownerId !== userId && !hasAccess(playlist, userId)) {
        throw createError({ statusCode: 403, statusMessage: "You don't have access to this playlist" });
    }

    const body = await readBody(event);
    const mediaIds: unknown = body?.mediaIds;
    if (!Array.isArray(mediaIds) || mediaIds.length === 0 || !mediaIds.every((id) => typeof id === "string")) {
        throw createError({ statusCode: 400, statusMessage: "`mediaIds` must be a non-empty array of media IDs" });
    }

    for (const mediaId of mediaIds) {
        if (!getMediaId(mediaId)) {
            throw createError({ statusCode: 404, statusMessage: `Media ${mediaId} not found` });
        }
    }

    return addEntries(pid, mediaIds, userId);
});
