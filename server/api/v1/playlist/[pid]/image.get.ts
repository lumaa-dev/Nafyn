// serves a playlist's cover image; public for public playlists, otherwise requires owner/member access
import { createReadStream, existsSync } from "node:fs";
import { getPlaylistById, hasAccess } from "~~/server/core/playlists";
import { playlistImageFilePath } from "~~/server/utils/playlistImage";
import { verifyAuthToken } from "~~/server/utils/jwt";

defineRouteMeta({
    openAPI: {
        description: "Serve a playlist's cover image. Public for public playlists; private ones require owner/member access. Since <img> elements can't set custom headers, the token may be passed as a `?token=` query param instead",
        tags: ["playlist"],
        operationId: "getPlaylistImage",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            },
            {
                name: "token",
                in: "query",
                required: false,
                description: "Auth token, as a fallback for clients that can't set the Authorization header (only needed for private playlists)",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "image/webp": { schema: { type: "string", format: "binary" } }
                }
            },
            "400": {
                description: "Missing playlist ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated (private playlist, missing/invalid token or no access)",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist not found, or has no image",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = await getPlaylistById(pid);
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

        if (!userId || (playlist.ownerId !== userId && !await hasAccess(playlist, userId))) {
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
