// GET /api/v1/art/{type}/{id}/{size} - a Cover Art Archive front cover, served from Nafyn's own disk cache.
//
// The archive is slow on a cold image (10-20 s through its redirect to archive.org), and a browser loading it
// directly shows a blank square for all of that, on every page, on every visit. Here it is fetched once, kept,
// and sent with an immutable cache header; a cold request waits a few seconds at most and otherwise answers 504
// so the client can show its placeholder and try again once the background fetch has landed.
//
// Authenticated like the uploaded-cover route (GET /library/{id}/cover): the URL goes into an <img src>, which
// can't send an Authorization header, so the `nafynToken` cookie is accepted too. The params are a validated
// (type, uuid, size) triple, never a URL.
import { sendStream } from "h3";
import { verifyAuthToken } from "~~/server/utils/jwt";
import { isUuid } from "~~/server/utils/ids";
import { getClientIP } from "~~/server/utils/clientIp";
import { consumeRateLimit } from "~~/server/utils/rateLimit";
import { getCachedCover, isCoverKind, isCoverSize } from "~~/server/utils/coverArtCache";

defineRouteMeta({
    openAPI: {
        description: "Get a Cover Art Archive front cover through Nafyn's cache. Accepts the token via the `Authorization` header, a `token` query param, or the `nafynToken` cookie.",
        tags: ["library"],
        operationId: "getCoverArt",
        parameters: [
            { name: "type", in: "path", required: true, description: "`release` or `release-group`", schema: { type: "string", enum: ["release", "release-group"] } },
            { name: "id", in: "path", required: true, description: "MusicBrainz release / release-group ID", schema: { type: "string", format: "uuid" } },
            { name: "size", in: "path", required: true, description: "Thumbnail edge in pixels", schema: { type: "integer", enum: [250, 500, 1000] } }
        ],
        responses: {
            "200": { description: "The image", content: { "image/jpeg": { schema: { type: "string", format: "binary" } } } },
            "400": { description: "Invalid type, ID or size", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "The archive has no cover for this release", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many requests", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "504": { description: "Not cached yet and the archive was too slow; retry shortly", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

// a library grid legitimately asks for dozens of covers at once; this only stops a loop
const MAX_PER_WINDOW = 900;
const WINDOW_MS = 60 * 1000;

export default defineEventHandler(async (event) => {
    const query = getQuery(event);
    const raw = getHeader(event, "Authorization") ?? (typeof query.token === "string" ? query.token : null) ?? getCookie(event, "nafynToken") ?? null;
    if (!raw) throw createError({ statusCode: 401, statusMessage: "Not authenticated" });

    const token = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : raw;
    let userId: string;
    try {
        userId = (await verifyAuthToken(token)).sub;
    } catch {
        throw createError({ statusCode: 401, statusMessage: "Invalid or expired token" });
    }

    const limit = consumeRateLimit(`art:${userId}:${getClientIP(event)}`, MAX_PER_WINDOW, WINDOW_MS);
    if (!limit.allowed) {
        setResponseHeader(event, "Retry-After", limit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many requests" });
    }

    const kind = getRouterParam(event, "type");
    const id = getRouterParam(event, "id");
    const size = Number(getRouterParam(event, "size"));
    if (!isCoverKind(kind) || !isUuid(id) || !isCoverSize(size)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid cover request" });
    }

    const cover = await getCachedCover(kind, id, size);
    if (cover === "missing") {
        setResponseHeader(event, "Cache-Control", "private, max-age=3600");
        throw createError({ statusCode: 404, statusMessage: "No cover for this release" });
    }
    if (!cover) {
        // not an error worth caching: the archive may simply be slow right now, and the fetch is still running
        setResponseHeader(event, "Cache-Control", "no-store");
        throw createError({ statusCode: 504, statusMessage: "Cover not available yet" });
    }

    setResponseHeader(event, "Content-Type", cover.contentType);
    setResponseHeader(event, "Cache-Control", "private, max-age=31536000, immutable");
    setResponseHeader(event, "X-Content-Type-Options", "nosniff");
    return sendStream(event, cover.stream());
});
