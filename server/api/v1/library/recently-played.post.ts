import { recordRecentlyPlayed, type RecentlyPlayedType } from "~~/server/core/recentlyPlayed";
import { findLibraryEntry, userOwnsAlbum } from "~~/server/core/library";
import { getPlaylistById, hasAccess } from "~~/server/core/playlists";

const TYPES: RecentlyPlayedType[] = ["track", "album", "playlist"];

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const body = await readBody(event);
    const type: unknown = body?.type;
    const refId: unknown = body?.refId;

    if (typeof type !== "string" || !TYPES.includes(type as RecentlyPlayedType) || typeof refId !== "string" || !refId) {
        throw createError({ statusCode: 400, statusMessage: "`type` and `refId` are required" });
    }

    // only ever record media the requesting user can actually see, so recently-played can't be used to probe
    // other users' library/playlist contents
    if (type === "track" && !findLibraryEntry(userId, refId)) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }
    if (type === "album" && !userOwnsAlbum(userId, refId)) {
        throw createError({ statusCode: 404, statusMessage: "Album not found in your library" });
    }
    if (type === "playlist") {
        const playlist = getPlaylistById(refId);
        if (!playlist || !hasAccess(playlist, userId)) {
            throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
        }
    }

    recordRecentlyPlayed(userId, type as RecentlyPlayedType, refId);
    return { recorded: true };
});
