// POST /api/v1/library/import - add a track to your library from a file you already have, with metadata you
// write yourself. The counterpart to POST /api/v1/request (which goes through Soulseek + MusicBrainz).
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { importManualTrack, type ManualTrackInput } from "~~/server/core/manualImport";
import { IMPORT_EXTENSIONS } from "~~/server/utils/audioImport";
import { MAX_LYRICS_LENGTH, type LyricsFormat } from "~~/server/core/mediaLyrics";

defineRouteMeta({
    openAPI: {
        description: "Import an audio file into the requesting user's library with user-supplied metadata. `multipart/form-data`: an `audio` file part, an optional `cover` image part, and a `metadata` JSON part (or the individual `title`/`artist`/`album`/... text parts).",
        tags: ["library"],
        operationId: "importTrack",
        requestBody: {
            required: true,
            content: {
                "multipart/form-data": {
                    schema: {
                        type: "object",
                        required: ["audio"],
                        properties: {
                            audio: { type: "string", format: "binary", description: `Audio file (${IMPORT_EXTENSIONS.join(", ")})` },
                            cover: { type: "string", format: "binary", description: "Cover image (PNG/JPEG/WebP)" },
                            metadata: { type: "string", description: "JSON object: title, artist, album, albumType, duration, trackNumber, releaseDate, label, lyrics" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "The created media row",
                content: { "application/json": { schema: { $ref: "#/components/schemas/MediaRow" } } }
            },
            "400": {
                description: "Missing/unreadable audio file, or invalid metadata",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "401": {
                description: "Not authenticated",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "413": {
                description: "Audio file or cover image too large",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            }
        }
    },
});

interface RawMetadata {
    title?: unknown,
    artist?: unknown,
    album?: unknown,
    albumType?: unknown,
    duration?: unknown,
    trackNumber?: unknown,
    releaseDate?: unknown,
    label?: unknown,
    lyrics?: unknown,
    lyricsFormat?: unknown
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
    const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(num) ? num : null;
}

// accepts either a unix-seconds number or a "YYYY-MM-DD"/ISO date string, since a form field is a string
function asDateSeconds(value: unknown): number | null {
    const num = asNumber(value);
    if (num !== null && typeof value !== "string") return Math.round(num);

    const text = asString(value);
    if (!text) return null;
    // a bare number in a text field is still unix seconds
    if (/^\d+$/.test(text.trim())) return Number(text.trim());

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : Math.floor(parsed.getTime() / 1000);
}

function toInput(raw: RawMetadata): ManualTrackInput {
    const albumType = asString(raw.albumType)?.toLowerCase();
    const lyricsContent = asString(raw.lyrics);
    const lyricsFormat: LyricsFormat = asString(raw.lyricsFormat)?.toLowerCase() === "lrc" ? "lrc" : "plain";

    if (lyricsContent && lyricsContent.length > MAX_LYRICS_LENGTH) {
        throw createError({ statusCode: 400, statusMessage: `Lyrics are too long (max ${MAX_LYRICS_LENGTH} characters)` });
    }

    return {
        title: asString(raw.title),
        artistName: asString(raw.artist),
        album: asString(raw.album),
        albumType: albumType === "album" || albumType === "ep" ? albumType : null,
        duration: asNumber(raw.duration),
        trackNumber: asNumber(raw.trackNumber),
        releaseDate: asDateSeconds(raw.releaseDate),
        label: asString(raw.label),
        lyrics: lyricsContent ? { format: lyricsFormat, content: lyricsContent } : null
    };
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const form = await readMultipartFormData(event);
    if (!form) {
        throw createError({ statusCode: 400, statusMessage: "Expected a multipart/form-data body" });
    }

    const audio = form.find((part) => part.name === "audio" || part.name === "file");
    if (!audio?.data?.length) {
        throw createError({ statusCode: 400, statusMessage: "Missing `audio` file" });
    }

    const cover = form.find((part) => part.name === "cover");

    // metadata arrives either as one JSON part or as individual text parts, whichever is easier for the caller
    const metadataPart = form.find((part) => part.name === "metadata");
    let raw: RawMetadata = {};
    if (metadataPart?.data) {
        try {
            const parsed = JSON.parse(metadataPart.data.toString("utf8"));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as RawMetadata;
        } catch {
            throw createError({ statusCode: 400, statusMessage: "`metadata` is not valid JSON" });
        }
    }
    for (const part of form) {
        if (!part.name || part.filename || part.name === "metadata") continue;
        if (raw[part.name as keyof RawMetadata] === undefined) {
            (raw as Record<string, unknown>)[part.name] = part.data.toString("utf8");
        }
    }

    const { media } = await importManualTrack(
        userId,
        { data: audio.data, filename: audio.filename, type: audio.type },
        toInput(raw),
        cover?.data?.length ? cover.data : null
    );

    return media;
});
