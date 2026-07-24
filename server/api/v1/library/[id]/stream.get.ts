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

export default defineEventHandler(async (event) => {
    const mediaId = getRouterParam(event, "id");
    if (!mediaId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media ID" });
    }

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

    const entry = findLibraryEntry(userId, mediaId);
    if (!entry) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    const stat = statSync(entry.filePath);
    const fileSize = stat.size;
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
