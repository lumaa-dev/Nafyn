// serves a playlist's cover image; public for public playlists, otherwise requires owner/member access
import { createReadStream, existsSync } from "node:fs";
import { getPlaylistById, hasAccess } from "~~/server/core/playlists";
import { playlistImageFilePath } from "~~/server/utils/playlistImage";
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

    if (playlist.privacy === "private") {
        // <img> elements can't set custom headers, so accept the token as a query param fallback too
        const authHeader = getHeader(event, "Authorization");
        const query = getQuery(event);
        let token = authHeader ?? (typeof query.token === "string" ? query.token : null);
        token = token?.startsWith("Bearer ") ? token.slice("Bearer ".length).trim() : token;

        let userId: string | null = null;
        try {
            if (token) userId = verifyAuthToken(token).sub;
        } catch {
            userId = null;
        }

        if (!userId || (playlist.ownerId !== userId && !hasAccess(playlist, userId))) {
            throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
        }
    }

    const path = playlistImageFilePath(pid);
    if (!existsSync(path)) {
        throw createError({ statusCode: 404, statusMessage: "Playlist has no image" });
    }

    setResponseHeader(event, "Content-Type", "image/webp");
    setResponseHeader(event, "Cache-Control", "private, max-age=3600");
    return sendStream(event, createReadStream(path));
});
