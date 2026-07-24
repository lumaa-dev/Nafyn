// per-user music library: shared `media` metadata rows + per-user `library_entries` ownership/file rows
import { randomUUID, UUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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

export interface LibraryPath {
    userId: UUID | string,
    artistId: UUID | string,
    albumId: UUID | string,
    trackId: UUID | string
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
        addedAt: Date.now()
    };

    getLibrariesDb().prepare(`
        INSERT INTO media (id, musicbrainzId, title, artistName, artistMbid, album, albumId, albumType, coverArt, releaseDate, duration, label, fingerprint, addedAt)
        VALUES (@id, @musicbrainzId, @title, @artistName, @artistMbid, @album, @albumId, @albumType, @coverArt, @releaseDate, @duration, @label, @fingerprint, @addedAt)
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

export function getMediaOfUser(userId: string): MediaRow[] {
    return getLibrariesDb().prepare(`
        SELECT media.*
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ?
    `).all(userId) as MediaRow[];
}

// one AlbumRow per distinct (artistName, album) pair owned by the user, aggregated from their media rows
export function getAlbumsOfUser(userId: string): AlbumRow[] {
    return getLibrariesDb().prepare(`
        SELECT
            media.albumId AS id,
            media.musicbrainzId AS mbId,
            media.album AS title,
            media.artistName AS artistName,
            media.artistMbid AS artistMbid,
            MIN(media.coverArt) AS coverArt,
            MIN(media.releaseDate) AS releaseDate,
            SUM(media.duration) AS duration,
            COUNT(*) AS trackCount
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.album IS NOT NULL
        GROUP BY media.artistName, media.album
    `).all(userId) as AlbumRow[];
}

export function getMediaId(mediaId: string): MediaRow | undefined {
    const row = getLibrariesDb().prepare(`SELECT * FROM media WHERE id = ? LIMIT 1`).get(mediaId) as MediaRow | undefined;    
    return row;
}

// physically copies an existing owner's file into `userId`'s library and records ownership, used when the song is already known
export async function copyMediaToUser(userId: string, media: MediaRow, sourceFilePath: string, extension: string): Promise<LibraryEntry> {
    let path: LibraryPath = { artistId: media.artistMbid ?? "Unknown Artist", albumId: media.album ?? "Unknown Album", trackId: media.id, userId }
    const destPath = libraryFilePath(userId, path, extension);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(sourceFilePath, destPath);
    return addLibraryEntry(userId, media.id, destPath);
}

export function libraryFilePath(userId: string, path: LibraryPath, extension: string): string {
    return `${process.cwd()}/music/library/${userId}/${path.artistId}/${path.albumId}/${path.trackId}${extension}`;
}
