// manual metadata editing for a track already in a library - downloaded from Soulseek or imported by hand.
//
// MusicBrainz is not always right (and for a manual import there is no MusicBrainz row at all), so a user
// can rewrite what a track claims to be. Two things have to stay in step: the `media` row every Nafyn
// surface reads from, and the tags embedded in the file on disk, which is what a third-party player sees
// when the library is browsed directly or shared back out.
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { tagAudioFile } from "../utils/audioTag";
import { manualAlbumId } from "./manualImport";
import {
    findAnyLibraryEntryForMedia,
    getMediaId,
    updateMediaFileSize,
    updateMediaMetadata,
    type MediaMetadataPatch,
    type MediaRow
} from "./library";

const TMP_DIR = join(process.cwd(), ".data", "tmp");

export interface MediaEdit {
    title?: string,
    artistName?: string,
    album?: string | null,
    albumType?: "album" | "ep" | null,
    releaseDate?: number | null,
    duration?: number,
    label?: string | null,
    trackNumber?: number | null,
    /** Cover Art Archive URL, or null to clear it. User-uploaded covers go through PUT .../cover instead. */
    coverArt?: string | null
}

// re-tags the shared file in place so the bytes on disk agree with the row. The file is shared between every
// user who owns the track, which is exactly why this is one write and not a per-user copy.
async function retagFile(filePath: string, media: MediaRow): Promise<void> {
    if (!existsSync(filePath)) return;

    const extension = extname(filePath);
    const tempPath = join(TMP_DIR, `${randomUUID()}${extension}`);

    await mkdir(TMP_DIR, { recursive: true });
    try {
        // ffmpeg can't write its output over its own input, so remux to a temp file and swap it in
        await tagAudioFile(filePath, tempPath, {
            title: media.title,
            artist: media.artistName,
            album: media.album,
            trackNumber: media.trackNumber,
            date: media.releaseDate ? new Date(media.releaseDate * 1000) : null,
            label: media.label
        });
        await rename(tempPath, filePath);
    } catch (error) {
        // the row is already updated and is what Nafyn itself reads; a failed retag leaves the file's own
        // tags stale rather than losing the edit, so log it and carry on
        console.error(`[mediaEdit] Could not retag ${filePath}: ${error}`);
        await rm(tempPath, { force: true }).catch(() => {});
    }
}

// applies a metadata edit to a media row and to the audio file behind it. Callers are responsible for
// checking that the requester is allowed to edit this row.
export async function applyMediaEdit(mediaId: string, edit: MediaEdit): Promise<MediaRow | null> {
    const existing = await getMediaId(mediaId);
    if (!existing) return null;

    const patch: MediaMetadataPatch = { ...edit };

    // album grouping keys off `albumId`. For a manual row that id is derived from album + artist, so a
    // renamed album has to be re-derived or the track stays grouped under its old album. Rows that came
    // from MusicBrainz keep their release-group MBID: it identifies the release, not the display title.
    if (existing.source === "manual" && (edit.album !== undefined || edit.artistName !== undefined)) {
        const album = edit.album !== undefined ? edit.album : existing.album;
        const artistName = edit.artistName !== undefined ? edit.artistName : existing.artistName;
        patch.albumId = manualAlbumId(album, artistName);
    }

    const updated = await updateMediaMetadata(mediaId, patch);
    if (!updated) return null;

    const entry = await findAnyLibraryEntryForMedia(mediaId);
    if (entry) {
        await retagFile(entry.filePath, updated);
        // remuxing changes the container's size, and the stored value feeds Subsonic's `size` and the
        // storage figures in settings
        if (existsSync(entry.filePath)) {
            await updateMediaFileSize(mediaId, statSync(entry.filePath).size);
            updated.fileSize = statSync(entry.filePath).size;
        }
    }

    return updated;
}
