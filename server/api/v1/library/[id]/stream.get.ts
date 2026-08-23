// serves an owned track's audio file with HTTP Range support, so <audio> can progressively buffer instead of downloading the whole file upfront
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { findLibraryEntry } from "~~/server/core/library";
import { verifyAuthToken } from "~~/server/utils/jwt";

const MIME_TYPES: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav"
};

defineRouteMeta({
    openAPI: {
        description: "Stream an owned track's audio file, with HTTP Range support for progressive playback. Since <audio>/<video> elements can't set custom headers, the token may be passed as a `?token=` query param instead of an Authorization header",
        tags: ["library"],
        operationId: "streamTrack",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Media ID",
                schema: { type: "string" }
            },
            {
                name: "token",
                in: "query",
                required: false,
                description: "Auth token, as a fallback for clients that can't set the Authorization header",
                schema: { type: "string" }
            },
            {
                name: "Range",
                in: "header",
                required: false,
                description: "Standard HTTP byte-range header, e.g. `bytes=0-1023`",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "Full file contents",
                content: {
                    "audio/mpeg": { schema: { type: "string", format: "binary" } },
                    "audio/flac": { schema: { type: "string", format: "binary" } },
                    "audio/ogg": { schema: { type: "string", format: "binary" } },
                    "audio/mp4": { schema: { type: "string", format: "binary" } },
                    "audio/wav": { schema: { type: "string", format: "binary" } },
                    "application/octet-stream": { schema: { type: "string", format: "binary" } }
                }
            },
            "206": {
                description: "Partial content for the requested byte range"
            },
            "400": {
                description: "Missing media ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Track not found in your library",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "416": {
                description: "Invalid or unsatisfiable Range header",
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
    // <audio>/<video> elements can't set custom headers, so accept the token as a query param here as a fallback
    const authHeader: string | undefined = getHeader(event, "Authorization");

    const query = getQuery(event);
    let token = authHeader ? authHeader : (typeof query.token == "string" ? query.token : null);

    if (!token) {
        throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
    }

    token = token.startsWith("Bearer ") ? token.slice("Bearer ".length).trim() : token

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

    const entry = await findLibraryEntry(userId, mediaId);
    if (!entry) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    // the row can outlive the file on disk (manual deletion, a half-finished download). Report that as a
    // plain 404 rather than letting an ENOENT escape as a 500 carrying a filesystem path in its message.
    let fileSize: number;
    try {
        fileSize = statSync(entry.filePath).size;
    } catch {
        throw createError({ statusCode: 404, statusMessage: "Track file is missing" });
    }
    const mime = MIME_TYPES[extname(entry.filePath).toLowerCase()] ?? "application/octet-stream";

    setResponseHeader(event, "Accept-Ranges", "bytes");
    setResponseHeader(event, "Content-Type", mime);
    setResponseHeader(event, "Cache-Control", "private, max-age=3600");

    const range = getHeader(event, "Range");
    if (!range) {
        setResponseHeader(event, "Content-Length", fileSize);
        return sendStream(event, createReadStream(entry.filePath));
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match || (!match[1] && !match[2])) {
        throw createError({ statusCode: 416, statusMessage: "Invalid Range header" });
    }

    const start = match[1] ? parseInt(match[1], 10) : fileSize - parseInt(match[2], 10);
    const end = match[1] && match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
        setResponseHeader(event, "Content-Range", `bytes */${fileSize}`);
        throw createError({ statusCode: 416, statusMessage: "Range not satisfiable" });
    }

    setResponseStatus(event, 206);
    setResponseHeader(event, "Content-Range", `bytes ${start}-${end}/${fileSize}`);
    setResponseHeader(event, "Content-Length", end - start + 1);

    return sendStream(event, createReadStream(entry.filePath, { start, end }));
});
