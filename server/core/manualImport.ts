// manual music import: a user uploads an audio file and writes its metadata themselves.
//
// This is the second way a track can enter a library. The download pipeline (core/downloads.ts) resolves
// everything from MusicBrainz; here there is no MusicBrainz entry at all, so the user is the source of
// truth for every field. Everything downstream of the `media` row is deliberately identical to a downloaded
// track: the same music/{album}/{title}.ext layout, the same ffmpeg retag, the same library_entries grant -
// so imported tracks play, queue, scrobble, appear over Subsonic and count towards insights like any other.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tagAudioFile } from "../utils/audioTag";
import { importExtension, probeAudioBuffer } from "../utils/audioImport";
import { saveMediaCover } from "../utils/mediaCover";
import { setMediaLyrics, type LyricsFormat } from "./mediaLyrics";
import {
    addLibraryEntry,
    insertMedia,
    libraryFilePath,
    updateMediaFileSize,
    deleteOrphanMediaRow,
    setMediaCustomCover,
    type MediaRow
} from "./library";

const TMP_DIR = join(process.cwd(), ".data", "tmp");

export interface ManualTrackInput {
    title?: string | null,
    artistName?: string | null,
    album?: string | null,
    albumType?: "album" | "ep" | null,
    /** Seconds. Falls back to the duration read out of the file itself. */
    duration?: number | null,
    trackNumber?: number | null,
    /** Unix seconds. */
    releaseDate?: number | null,
    label?: string | null,
    lyrics?: { format: LyricsFormat, content: string } | null
}

// Manual tracks have no release-group MBID, but the library still groups albums by `albumId` - so derive a
// stable synthetic one from the album + artist the user typed. Two imports naming the same album by the same
// artist land in the same album; the value is namespaced so it can never collide with a real MBID, and it is
// deterministic so a later import joins an album that already exists rather than creating a second one.
export function manualAlbumId(album: string | null, artistName: string): string {
    if (!album) return "unknown-album";
    const key = `${album.trim().toLowerCase()}|${artistName.trim().toLowerCase()}`;
    return `manual-${createHash("sha1").update(key).digest("hex").slice(0, 32)}`;
}

function clean(value: string | null | undefined, fallback: string): string {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed.slice(0, 500) : fallback;
}

function optional(value: string | null | undefined): string | null {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

export interface ManualImportResult {
    media: MediaRow,
    filePath: string
}

// writes one uploaded file into `userId`'s library under the metadata they supplied
export async function importManualTrack(
    userId: string,
    file: { data: Buffer, filename?: string, type?: string },
    input: ManualTrackInput,
    coverImage?: Buffer | null
): Promise<ManualImportResult> {
    const extension = importExtension(file.filename, file.type);
    const probed = await probeAudioBuffer(file.data, extension);

    // the file's own tags fill in whatever the user left blank, and its decoded duration is the fallback -
    // a duration the client invents would desync the player, scrobbling and listening insights
    const title = clean(input.title ?? probed.title, "Untitled");
    const artistName = clean(input.artistName ?? probed.artist, "Unknown Artist");
    const album = optional(input.album ?? probed.album);
    const duration = input.duration && Number.isFinite(input.duration) && input.duration > 0
        ? Math.round(input.duration)
        : probed.duration;
    const trackNumber = input.trackNumber && input.trackNumber > 0 ? Math.round(input.trackNumber) : probed.trackNumber;
    const releaseDate = input.releaseDate && Number.isFinite(input.releaseDate)
        ? Math.round(input.releaseDate)
        : (probed.year ? Math.floor(Date.UTC(probed.year, 0, 1) / 1000) : null);

    const media = await insertMedia({
        // no MusicBrainz recording to point at; a fresh UUID keeps the column's shape and, being unique,
        // keeps findMediaByMusicbrainzId's dedup logic from ever tying two imports together
        musicbrainzId: randomUUID(),
        title,
        artistName,
        artistMbid: "",
        album,
        albumId: manualAlbumId(album, artistName),
        albumType: input.albumType ?? (album ? "album" : null),
        coverArt: null,
        releaseDate,
        duration,
        label: optional(input.label),
        fingerprint: null,
        amId: null,
        fileSize: null,
        source: "manual",
        trackNumber
    });

    const tempPath = join(TMP_DIR, `${randomUUID()}${extension}`);
    const destPath = libraryFilePath(album, artistName, title, extension);

    try {
        await mkdir(TMP_DIR, { recursive: true });
        await mkdir(dirname(destPath), { recursive: true });
        await writeFile(tempPath, file.data);

        // same remux-and-retag step the download pipeline ends on, so the file on disk carries the metadata
        // the user entered rather than whatever tags it arrived with
        await tagAudioFile(tempPath, destPath, {
            title,
            artist: artistName,
            album,
            trackNumber,
            date: releaseDate ? new Date(releaseDate * 1000) : null,
            label: optional(input.label)
        });

        const cover = coverImage ?? probed.picture;
        if (cover) {
            await saveMediaCover(media.id, cover);
            await setMediaCustomCover(media.id, true);
            media.hasCustomCover = 1;
        }

        if (input.lyrics && input.lyrics.content.trim().length > 0) {
            await setMediaLyrics(media.id, input.lyrics.format, input.lyrics.content);
        }

        await updateMediaFileSize(media.id, statSync(destPath).size);
        await addLibraryEntry(userId, media.id, destPath);

        return { media, filePath: destPath };
    } catch (error) {
        // nothing owns this row yet, so removing it is safe - otherwise a failed import leaves an
        // unreachable media row behind (the same orphan case core/downloads.ts guards against)
        await rm(destPath, { force: true }).catch(() => {});
        await deleteOrphanMediaRow(media.id).catch(() => {});
        throw error;
    } finally {
        await rm(tempPath, { force: true }).catch(() => {});
    }
}
