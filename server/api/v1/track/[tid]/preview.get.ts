import { assertMbid } from "~~/server/utils/ids";
import { getPreviewAudio, hasCachedPreviewAudio } from "~~/server/utils/trackPreview";
import { enforceUpstreamLookupLimit } from "~~/server/utils/rateLimit";
import { MusicBrainzError } from "~~/server/utils/musicbrainzRepository";

defineRouteMeta({
    openAPI: {
        description: "The 30-second preview of a track (MusicBrainz recording ID), from Apple's iTunes catalogue, for tracks the user doesn't own. The audio is served by Nafyn itself, with HTTP Range support. Since <audio> elements can't set custom headers, the token may be passed as a `?token=` query param. 404 when iTunes has no preview of that recording",
        tags: ["track"],
        operationId: "getTrackPreview",
        parameters: [
            { name: "tid", in: "path", required: true, description: "MusicBrainz recording ID", schema: { type: "string", format: "uuid" } },
            { name: "token", in: "query", required: false, description: "Auth token, for clients that can't set the Authorization header", schema: { type: "string" } },
            { name: "Range", in: "header", required: false, description: "Standard HTTP byte-range header", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "The whole preview", content: { "audio/mp4": { schema: { type: "string", format: "binary" } } } },
            "206": { description: "Partial content for the requested byte range" },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No preview for this track", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "416": { description: "Unsatisfiable Range header" },
            "503": { description: "MusicBrainz is unavailable", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthTokenAllowQuery(event);
    const tid = assertMbid(getRouterParam(event, "tid"));

    let audio: Awaited<ReturnType<typeof getPreviewAudio>>;
    try {
        // the first play costs a MusicBrainz lookup and an iTunes call; after that (and for every byte range a
        // player asks for) it is served from memory
        if (!hasCachedPreviewAudio(tid)) enforceUpstreamLookupLimit(event, userId);
        audio = await getPreviewAudio(tid);
    } catch (error) {
        if (error instanceof MusicBrainzError) {
            if (error.status === 404 || error.status === 400) throw createError({ statusCode: 404, statusMessage: "No such track" });
            throw createError({ statusCode: 503, statusMessage: "MusicBrainz is unavailable" });
        }
        throw error;
    }
    if (!audio) throw createError({ statusCode: 404, statusMessage: "No preview for this track" });

    const size = audio.bytes.byteLength;
    setResponseHeader(event, "Accept-Ranges", "bytes");
    setResponseHeader(event, "Content-Type", audio.contentType);
    setResponseHeader(event, "Cache-Control", "private, max-age=3600");

    const range = getHeader(event, "Range");
    if (!range) {
        setResponseHeader(event, "Content-Length", size);
        return audio.bytes;
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match || (!match[1] && !match[2])) throw createError({ statusCode: 416, statusMessage: "Invalid Range header" });
    const start = match[1] ? parseInt(match[1], 10) : Math.max(0, size - parseInt(match[2]!, 10));
    const end = match[1] && match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1;
    if (start >= size || start > end) {
        setResponseHeader(event, "Content-Range", `bytes */${size}`);
        throw createError({ statusCode: 416, statusMessage: "Range not satisfiable" });
    }

    setResponseStatus(event, 206);
    setResponseHeader(event, "Content-Range", `bytes ${start}-${end}/${size}`);
    setResponseHeader(event, "Content-Length", end - start + 1);
    return audio.bytes.subarray(start, end + 1);
});
