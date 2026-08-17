// removes a single entry; members may only remove entries they personally added, the owner can remove any entry
import { getPlaylistById, getEntryById, removeEntry } from "~~/server/core/playlists";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const pid = getRouterParam(event, "pid");
    const eid = getRouterParam(event, "eid");
    if (!pid || !eid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist or entry ID" });
    }

    const playlist = getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    const entry = getEntryById(eid);
    if (!entry || entry.playlistId !== pid) {
        throw createError({ statusCode: 404, statusMessage: "Entry not found" });
    }

    const isOwner = playlist.ownerId === userId;
    const isAdder = entry.addedBy === userId;
    if (!isOwner && !isAdder) {
        throw createError({ statusCode: 403, statusMessage: "You can only remove tracks you added" });
    }

    removeEntry(eid);

    return { removed: true };
});
