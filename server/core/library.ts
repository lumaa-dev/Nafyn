// per-user music library: shared `media` metadata rows + shared audio file on disk, `library_entries` only grants per-user access
import { randomUUID, UUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { getLibrariesDb } from "./db";

export interface MediaRow {
    id: string,
    musicbrainzId: string,
    title: string,
    artistName: string,
    artistMbid: string,
    album: string | null,
    albumId: string
    albumType: "album" | "ep" | null,
    coverArt: string | null,
    releaseDate: number | null,
    duration: number,
    label: string | null,
    fingerprint: string | null,
    amId: string | null,
    fileSize: number | null,
    addedAt: number
}

export interface AlbumRow {
    id: string,
    mbId: string,
    title: string,
    artistName: string,
    artistMbid: string,
    coverArt: string | null,
    releaseDate: number | null,
    duration: number,
    trackCount: number,
}

export interface LibraryEntry {
    id: string,
    userId: string,
    mediaId: string,
    filePath: string,
    addedAt: number
}

// any existing media row for this MusicBrainz recording, regardless of who owns it, used to skip a redundant download
export function findMediaByMusicbrainzId(musicbrainzId: string): MediaRow | null {
    const row = getLibrariesDb().prepare(`SELECT * FROM media WHERE musicbrainzId = ? LIMIT 1`).get(musicbrainzId) as MediaRow | undefined;
    return row ?? null;
}

export function findLibraryEntry(userId: string, mediaId: string): LibraryEntry | null {
    const row = getLibrariesDb().prepare(`SELECT * FROM library_entries WHERE userId = ? AND mediaId = ?`).get(userId, mediaId) as LibraryEntry | undefined;
    return row ?? null;
}

export function getLibraryOfUser(userId: string): LibraryEntry | null {
    const row = getLibrariesDb().prepare(`SELECT * FROM library_entries WHERE userId = ?`).get(userId) as LibraryEntry | undefined;
    return row ?? null;
}

// one existing owner's entry for a given media row, used as the copy source
export function findAnyLibraryEntryForMedia(mediaId: string): LibraryEntry | null {
    const row = getLibrariesDb().prepare(`SELECT * FROM library_entries WHERE mediaId = ? LIMIT 1`).get(mediaId) as LibraryEntry | undefined;
    return row ?? null;
}

export function insertMedia(media: Omit<MediaRow, "id" | "addedAt"> & { id?: string }): MediaRow {
    const row: MediaRow = {
        id: media.id ?? randomUUID(),
        musicbrainzId: media.musicbrainzId,
        title: media.title,
        artistName: media.artistName,
        artistMbid: media.artistMbid,
        album: media.album,
        albumId: media.albumId,
        albumType: media.albumType,
        coverArt: media.coverArt,
        releaseDate: media.releaseDate,
        duration: media.duration,
        label: media.label,
        fingerprint: media.fingerprint,
        amId: media.amId,
        fileSize: media.fileSize,
        addedAt: Date.now()
    };

    getLibrariesDb().prepare(`
        INSERT INTO media (id, musicbrainzId, title, artistName, artistMbid, album, albumId, albumType, coverArt, releaseDate, duration, label, fingerprint, amId, fileSize, addedAt)
        VALUES (@id, @musicbrainzId, @title, @artistName, @artistMbid, @album, @albumId, @albumType, @coverArt, @releaseDate, @duration, @label, @fingerprint, @amId, @fileSize, @addedAt)
    `).run(row);

    return row;
}

export function addLibraryEntry(userId: string, mediaId: string, filePath: string): LibraryEntry {
    const entry: LibraryEntry = {
        id: randomUUID(),
        userId,
        mediaId,
        filePath,
        addedAt: Date.now()
    };

    getLibrariesDb().prepare(`
        INSERT INTO library_entries (id, userId, mediaId, filePath, addedAt)
        VALUES (@id, @userId, @mediaId, @filePath, @addedAt)
    `).run(entry);

    return entry;
}

// true if any of the user's library entries belong to this albumId (release-group MBID)
export function userOwnsAlbum(userId: string, albumId: string): boolean {
    const row = getLibrariesDb().prepare(`
        SELECT 1 FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.albumId = ?
        LIMIT 1
    `).get(userId, albumId);
    return !!row;
}

export function getMediaOfUser(userId: string): MediaRow[] {
    return getLibrariesDb().prepare(`
        SELECT media.*
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ?
    `).all(userId) as MediaRow[];
}

// one AlbumRow per distinct albumId (release-group MBID) owned by the user, aggregated from their media rows;
// grouping must key off albumId (not the display title) since SQLite returns an arbitrary row's value for any
// selected column that isn't in GROUP BY or wrapped in an aggregate, which made `id`/`mbId` nondeterministic
export function getAlbumsOfUser(userId: string): AlbumRow[] {
    return getLibrariesDb().prepare(`
        SELECT
            media.albumId AS id,
            MIN(media.musicbrainzId) AS mbId,
            MIN(media.album) AS title,
            MIN(media.artistName) AS artistName,
            MIN(media.artistMbid) AS artistMbid,
            MIN(media.coverArt) AS coverArt,
            MIN(media.releaseDate) AS releaseDate,
            SUM(media.duration) AS duration,
            COUNT(*) AS trackCount
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.album IS NOT NULL AND media.albumId IS NOT NULL AND media.albumId != 'unknown-album'
        GROUP BY media.albumId
    `).all(userId) as AlbumRow[];
}

// total bytes across every distinct media row (the shared pool, not per-user)
export function getTotalMediaSize(): number {
    const row = getLibrariesDb().prepare(`SELECT SUM(fileSize) AS total FROM media`).get() as { total: number | null };
    return row.total ?? 0;
}

// bytes owned per user, summed across their library entries (a shared track counts for each owner)
export function getStorageByUser(): { userId: string, bytes: number }[] {
    return getLibrariesDb().prepare(`
        SELECT library_entries.userId AS userId, SUM(media.fileSize) AS bytes
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        GROUP BY library_entries.userId
    `).all() as { userId: string, bytes: number }[];
}

export function updateMediaFileSize(mediaId: string, fileSize: number): void {
    getLibrariesDb().prepare(`UPDATE media SET fileSize = ? WHERE id = ?`).run(fileSize, mediaId);
}

// every media row plus the userIds that own a library entry for it, for the MANAGE_MUSIC "everyone's library" view
export function getAllMediaWithOwners(): (MediaRow & { ownerIds: string[] })[] {
    const media = getLibrariesDb().prepare(`SELECT * FROM media ORDER BY addedAt DESC`).all() as MediaRow[];
    const entries = getLibrariesDb().prepare(`SELECT userId, mediaId FROM library_entries`).all() as { userId: string, mediaId: string }[];

    const ownersByMedia = new Map<string, string[]>();
    for (const entry of entries) {
        const list = ownersByMedia.get(entry.mediaId) ?? [];
        list.push(entry.userId);
        ownersByMedia.set(entry.mediaId, list);
    }

    return media.map((row) => ({ ...row, ownerIds: ownersByMedia.get(row.id) ?? [] }));
}

export function getMediaId(mediaId: string): MediaRow | undefined {
    const row = getLibrariesDb().prepare(`SELECT * FROM media WHERE id = ? LIMIT 1`).get(mediaId) as MediaRow | undefined;    
    return row;
}

// grants `userId` access to an already-downloaded song, no file copy needed since all users share the one file on disk
export function shareMediaWithUser(userId: string, media: MediaRow, sharedFilePath: string): LibraryEntry {
    return addLibraryEntry(userId, media.id, sharedFilePath);
}

export function libraryFilePath(mediaId: string, extension: string): string {
    return `${process.cwd()}/music/${mediaId}${extension}`;
}

// revokes every library entry a user has, used when an account is deleted so no orphaned entries linger
export async function deleteAllLibraryEntriesForUser(userId: string): Promise<void> {
    const media = getMediaOfUser(userId);
    for (const row of media) {
        await deleteLibraryEntryForUser(userId, row.id);
    }
}

// revokes `userId`'s access to a song; once no user references it anymore, the shared file and media row are deleted too
export async function deleteLibraryEntryForUser(userId: string, mediaId: string): Promise<{ removed: boolean, fileDeleted: boolean }> {
    const entry = findLibraryEntry(userId, mediaId);
    if (!entry) return { removed: false, fileDeleted: false };

    const db = getLibrariesDb();
    db.prepare(`DELETE FROM library_entries WHERE id = ?`).run(entry.id);

    const { count } = db.prepare(`SELECT COUNT(*) AS count FROM library_entries WHERE mediaId = ?`).get(mediaId) as { count: number };
    if (count === 0) {
        await rm(entry.filePath, { force: true });
        db.transaction(() => {
            db.prepare(`DELETE FROM playlist_entries WHERE mediaId = ?`).run(mediaId);
            db.prepare(`DELETE FROM media WHERE id = ?`).run(mediaId);
        })();
        return { removed: true, fileDeleted: true };
    }

    return { removed: true, fileDeleted: false };
}
