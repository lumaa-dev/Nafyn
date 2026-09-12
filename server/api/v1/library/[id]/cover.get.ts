// GET /api/v1/library/{id}/cover - serves a cover image a user uploaded for one of their tracks.
//
// Unlike the rest of /library, this accepts the auth token from the `nafynToken` cookie as well: the URL
// ends up in an <img src>, which can't carry an Authorization header (the same reason the streaming route
// takes a `?token=`). The token is still verified either way - a cover is library content, not public.
import { createReadStream, existsSync } from "node:fs";
import { verifyAuthToken } from "~~/server/utils/jwt";
import { findLibraryEntry, getMediaId } from "~~/server/core/library";
import { mediaCoverFilePath } from "~~/server/utils/mediaCover";

defineRouteMeta({
    openAPI: {
        description: "Get the user-uploaded cover image of a library track. Accepts the token via the `Authorization` header, a `token` query param, or the `nafynToken` cookie.",
        tags: ["library"],
        operationId: "getTrackCover",
        parameters: [
            { name: "id", in: "path", required: true, description: "Nafyn media ID", schema: { type: "string" } },
            { name: "token", in: "query", required: false, description: "Auth token, for contexts that can't send headers", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "WebP image", content: { "image/webp": { schema: { type: "string", format: "binary" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No such track in your library, or it has no uploaded cover", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const header = getHeader(event, "Authorization");
    const query = getQuery(event);
    const cookie = getCookie(event, "nafynToken");
    let token = header ?? (typeof query.token === "string" ? query.token : null) ?? cookie ?? null;

    if (!token) {
        throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
    }
    token = token.startsWith("Bearer ") ? token.slice("Bearer ".length).trim() : token;

    let userId: string;
    try {
        userId = verifyAuthToken(token).sub;
    } catch {
        throw createError({ statusCode: 401, statusMessage: "Invalid or expired token" });
    }

    const mediaId = getRouterParam(event, "id");
    if (!mediaId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media ID" });
    }

    // SECURITY: scoped to the caller's own library, like every other /library route
    const media = await getMediaId(mediaId);
    if (!media || !await findLibraryEntry(userId, mediaId)) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    const path = mediaCoverFilePath(mediaId);
    if (!media.hasCustomCover || !existsSync(path)) {
        throw createError({ statusCode: 404, statusMessage: "No uploaded cover for this track" });
    }

    setResponseHeader(event, "Content-Type", "image/webp");
    setResponseHeader(event, "Cache-Control", "private, max-age=3600");
    return sendStream(event, createReadStream(path));
});
