// moving a track to another album: "Bad Decisions" came out as a single, and belongs on "The New Abnormal".
//
// The target is a MusicBrainz release-group. What the album gives the track - its title, type, cover, date and
// the track's place on it (disc and position, when the album lists the recording) - is taken from MusicBrainz
// exactly like the download pipeline would have tagged it. The file follows: it moves into the album's folder,
// and the folder it leaves is removed when it is empty. The old album needs no deleting of its own - albums are
// the library's tracks grouped by `albumId`, so one with no track left is simply gone.
import { applyMediaEdit, type MediaEdit } from "./mediaEdit";
import { getMediaId, relocateMediaFile, type MediaRow } from "./library";
import { getLibrariesDb } from "./db";
import { getAlbumContents, type AlbumContents } from "../utils/albumContents";
import { getMusicBrainzRepository, parseReleaseDate } from "../utils/musicbrainz";
import { coverArchiveUrl } from "../utils/coverUrl";
import { normalizeForMatch, SAME_SONG_DURATION_TOLERANCE_SECONDS } from "../utils/mediaIdentity";

export class AlbumNotFoundError extends Error {
    constructor(albumId: string) {
        super(`MusicBrainz has no usable release for album ${albumId}`);
        this.name = "AlbumNotFoundError";
    }
}

// the album's own entry for this recording: by MBID (or any MBID the track is known by, a merged recording),
// else by title + length, which is also what finds a manual import
async function findTrackOnAlbum(media: MediaRow, contents: AlbumContents): Promise<AlbumContents["tracks"][number] | null> {
    const known = new Set([media.musicbrainzId]);
    const aliases = await getLibrariesDb()
        .prepare(`SELECT value FROM media_identifiers WHERE mediaId = ? AND kind = 'mbid'`)
        .all(media.id) as { value: string }[];
    for (const { value } of aliases) known.add(value);

    const byId = contents.tracks.find((track) => known.has(track.id));
    if (byId) return byId;

    const title = normalizeForMatch(media.title);
    if (!title) return null;
    return contents.tracks.find((track) => {
        if (normalizeForMatch(track.title) !== title) return false;
        // MusicBrainz lengths are milliseconds; either side may not know it
        if (track.length === null || media.duration <= 0) return true;
        return Math.abs(track.length / 1000 - media.duration) <= SAME_SONG_DURATION_TOLERANCE_SECONDS * 2;
    }) ?? null;
}

/**
 * Puts a track on the given MusicBrainz release-group. Callers check that the requester may edit the row.
 * Throws `AlbumNotFoundError` (no such album), or whatever MusicBrainz throws when it is unreachable.
 * Returns the row as it is now, or null if it is gone.
 */
export async function moveMediaToAlbum(mediaId: string, albumId: string): Promise<MediaRow | null> {
    const media = await getMediaId(mediaId);
    if (!media) return null;
    if (media.albumId === albumId) return media;

    const contents = await getAlbumContents(getMusicBrainzRepository(), albumId);
    if (!contents) throw new AlbumNotFoundError(albumId);

    const onAlbum = await findTrackOnAlbum(media, contents);
    const albumDate = parseReleaseDate(contents.releaseDate ?? undefined);

    const edit: MediaEdit = {
        album: contents.albumTitle,
        albumId: contents.albumId,
        albumType: contents.albumType,
        coverArt: coverArchiveUrl("release-group", contents.albumId, 500),
        // the album's disc and position for the track; null when the album does not list the recording
        trackNumber: onAlbum?.position ?? null,
        discNumber: onAlbum?.discNumber ?? null,
        discTitle: onAlbum?.discTitle ?? null,
        ...(albumDate ? { releaseDate: Math.floor(albumDate.getTime() / 1000) } : {})
    };

    // metadata and tags first, then the file: should the move fail, the track is still playable from where it is
    const updated = await applyMediaEdit(mediaId, edit);
    if (!updated) return null;

    try {
        await relocateMediaFile(mediaId);
    } catch (error) {
        console.error(`[mediaAlbum] Could not move the file of ${mediaId} into its new album folder: ${error}`);
    }
    return updated;
}
