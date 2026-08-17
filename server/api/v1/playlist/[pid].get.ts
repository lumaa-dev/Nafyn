// playlist detail; public playlists are readable by anonymous visitors, private ones require owner/member access
import { getPlaylistById, getMembers, getEntries, hasAccess } from "~~/server/core/playlists";
import { getUserById } from "~~/server/core/users";
import { verifyAuthToken } from "~~/server/utils/jwt";

export default defineEventHandler(async (event) => {
    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    // best-effort auth: anonymous visitors are allowed on public playlists, so a missing/invalid token isn't fatal here
    let userId: string | null = null;
    const auth = getHeader(event, "Authorization");
    if (auth?.startsWith("Bearer ")) {
        try {
            userId = verifyAuthToken(auth.slice("Bearer ".length).trim()).sub;
        } catch {
            userId = null;
        }
    }

    const isOwner = userId === playlist.ownerId;
    const isMember = !!userId && hasAccess(playlist, userId);

    if (playlist.privacy === "private" && !isOwner && !isMember) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    const owner = getUserById(playlist.ownerId, true);
    const members = getMembers(playlist.id)
        .map((m) => getUserById(m.userId, true))
        .filter((u) => u !== null);

    const entries = getEntries(playlist.id).map((entry) => ({
        entryId: entry.entryId,
        addedBy: getUserById(entry.addedBy, true),
        position: entry.position,
        addedAt: entry.addedAt,
        media: entry.media
    }));

    return {
        playlist,
        owner,
        members,
        entries,
        viewer: { userId, isOwner, isMember }
    };
});
