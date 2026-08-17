import { getPlaylistById, hasAccess, updatePlaylist } from "~~/server/core/playlists";

const SORT_MODES = ["manual", "title", "artist", "addedBy", "duration"];

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

    const isOwner = playlist.ownerId === userId;
    const body = await readBody(event);
    const patch: Parameters<typeof updatePlaylist>[1] = {};

    // sortMode is a shared view preference: owner or any invited member may change it
    if (typeof body?.sortMode === "string") {
        if (!isOwner && !hasAccess(playlist, userId)) {
            throw createError({ statusCode: 403, statusMessage: "You don't have access to this playlist" });
        }
        if (!SORT_MODES.includes(body.sortMode)) {
            throw createError({ statusCode: 400, statusMessage: "Invalid sortMode" });
        }
        patch.sortMode = body.sortMode;
    }

    const editsDetails = typeof body?.title === "string" || typeof body?.description === "string" || body?.description === null || body?.privacy === "public" || body?.privacy === "private";
    if (editsDetails && !isOwner) {
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can edit its details" });
    }

    if (typeof body?.title === "string") {
        const title = body.title.trim();
        if (title.length < 1 || title.length > 100) {
            throw createError({ statusCode: 400, statusMessage: "Title must be between 1 and 100 characters" });
        }
        patch.title = title;
    }

    if (typeof body?.description === "string" || body?.description === null) {
        patch.description = typeof body.description === "string" ? body.description.trim() || null : null;
    }

    if (body?.privacy === "public" || body?.privacy === "private") {
        patch.privacy = body.privacy;
    }

    return updatePlaylist(pid, patch);
});
