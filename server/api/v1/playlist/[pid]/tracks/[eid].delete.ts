// removes a single entry; members may only remove entries they personally added, the owner can remove any entry,
// and MANAGE_MUSIC users can remove any entry from any playlist
import { getPlaylistById, getEntryById, removeEntry } from "~~/server/core/playlists";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

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
    const canManageMusic = hasPermission(getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC);
    if (!isOwner && !isAdder && !canManageMusic) {
        throw createError({ statusCode: 403, statusMessage: "You can only remove tracks you added" });
    }

    removeEntry(eid);

    return { removed: true };
});
