// manual audio import: validating a user-uploaded audio file and reading what the file itself already knows.
//
// The download pipeline gets its metadata from MusicBrainz, so it never needed this. A manual import has no
// MusicBrainz entry at all - the user is the source of truth - but the file's own tags and its real duration
// make a much better starting point for the import form than an empty one, and the duration in particular
// should never be taken from the client (the player, scrobbling and insights all key off it).
import { parseBuffer, type IAudioMetadata } from "music-metadata";
import { extname } from "node:path";

// same set the download pipeline accepts, so an imported file streams through the exact same code paths
export const IMPORT_EXTENSIONS = [".mp3", ".flac", ".ogg", ".wav"];
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav"
};

export interface ProbedAudio {
    /** Seconds, rounded - read from the decoded stream, never from the uploader. */
    duration: number,
    title: string | null,
    artist: string | null,
    album: string | null,
    trackNumber: number | null,
    year: number | null,
    /** Embedded cover art, if the file carries one. */
    picture: Buffer | null
}

// SECURITY: a client-supplied filename is only ever trusted for its extension (same rule as the Soulseek
// pipeline), and even that is checked against the allowlist rather than used as-is - the file Nafyn writes
// is named from Nafyn's own data, so a crafted name can't traverse or spoof a type.
export function importExtension(fileName: string | undefined, mimeType: string | undefined): string {
    const fromName = extname((fileName ?? "").replace(/\\/g, "/")).toLowerCase();
    if (IMPORT_EXTENSIONS.includes(fromName)) return fromName;

    const fromMime = Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === (mimeType ?? "").toLowerCase())?.[0];
    if (fromMime) return fromMime;

    throw createError({
        statusCode: 400,
        statusMessage: `Unsupported audio format (accepted: ${IMPORT_EXTENSIONS.join(", ")})`
    });
}

// parses the uploaded bytes as audio. Doubles as the "is this actually an audio file" check: anything
// music-metadata can't decode a stream out of is rejected before it ever reaches disk.
export async function probeAudioBuffer(buffer: Buffer, extension: string): Promise<ProbedAudio> {
    if (buffer.length === 0) {
        throw createError({ statusCode: 400, statusMessage: "Audio file is empty" });
    }
    if (buffer.length > MAX_IMPORT_BYTES) {
        throw createError({ statusCode: 413, statusMessage: `Audio file is too large (max ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB)` });
    }

    let metadata: IAudioMetadata;
    try {
        metadata = await parseBuffer(buffer, { mimeType: MIME_BY_EXTENSION[extension] });
    } catch {
        throw createError({ statusCode: 400, statusMessage: "Could not read that file as audio" });
    }

    const duration = metadata.format.duration;
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
        throw createError({ statusCode: 400, statusMessage: "Could not determine the audio's duration" });
    }

    const picture = metadata.common.picture?.[0]?.data;

    return {
        duration: Math.round(duration),
        title: metadata.common.title ?? null,
        artist: metadata.common.artist ?? metadata.common.albumartist ?? null,
        album: metadata.common.album ?? null,
        trackNumber: metadata.common.track?.no ?? null,
        year: metadata.common.year ?? null,
        picture: picture ? Buffer.from(picture) : null
    };
}
