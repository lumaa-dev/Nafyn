// per-user music library: shared `media` metadata rows + shared audio file on disk, `library_entries` only grants per-user access
import { randomUUID, UUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getLibrariesDb, withTransaction } from "./db";

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
export async function findMediaByMusicbrainzId(musicbrainzId: string): Promise<MediaRow | null> {
    const row = await getLibrariesDb().prepare(`SELECT * FROM media WHERE musicbrainzId = ? LIMIT 1`).get(musicbrainzId) as MediaRow | undefined;
    return row ?? null;
}

export async function findLibraryEntry(userId: string, mediaId: string): Promise<LibraryEntry | null> {
    const row = await getLibrariesDb().prepare(`SELECT * FROM library_entries WHERE userId = ? AND mediaId = ?`).get(userId, mediaId) as LibraryEntry | undefined;
    return row ?? null;
}

export async function getLibraryOfUser(userId: string): Promise<LibraryEntry | null> {
    const row = await getLibrariesDb().prepare(`SELECT * FROM library_entries WHERE userId = ?`).get(userId) as LibraryEntry | undefined;
    return row ?? null;
}

// one existing owner's entry for a given media row, used as the copy source
export async function findAnyLibraryEntryForMedia(mediaId: string): Promise<LibraryEntry | null> {
    const row = await getLibrariesDb().prepare(`SELECT * FROM library_entries WHERE mediaId = ? LIMIT 1`).get(mediaId) as LibraryEntry | undefined;
    return row ?? null;
}

export async function insertMedia(media: Omit<MediaRow, "id" | "addedAt"> & { id?: string }): Promise<MediaRow> {
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

    await getLibrariesDb().prepare(`
        INSERT INTO media (id, musicbrainzId, title, artistName, artistMbid, album, albumId, albumType, coverArt, releaseDate, duration, label, fingerprint, amId, fileSize, addedAt)
        VALUES (:id, :musicbrainzId, :title, :artistName, :artistMbid, :album, :albumId, :albumType, :coverArt, :releaseDate, :duration, :label, :fingerprint, :amId, :fileSize, :addedAt)
    `).run(row);

    return row;
}

export async function addLibraryEntry(userId: string, mediaId: string, filePath: string): Promise<LibraryEntry> {
    const entry: LibraryEntry = {
        id: randomUUID(),
        userId,
        mediaId,
        filePath,
        addedAt: Date.now()
    };

    await getLibrariesDb().prepare(`
        INSERT INTO library_entries (id, userId, mediaId, filePath, addedAt)
        VALUES (:id, :userId, :mediaId, :filePath, :addedAt)
    `).run(entry);

    return entry;
}

// true if any of the user's library entries belong to this albumId (release-group MBID)
export async function userOwnsAlbum(userId: string, albumId: string): Promise<boolean> {
    const row = await getLibrariesDb().prepare(`
        SELECT 1 FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.albumId = ?
        LIMIT 1
    `).get(userId, albumId);
    return !!row;
}

export async function getMediaOfUser(userId: string, limit?: number, offset?: number): Promise<MediaRow[]> {
    let sql = `
        SELECT media.*
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ?
        ORDER BY media.addedAt DESC
    `;
    const params: unknown[] = [userId];
    if (limit !== undefined) {
        sql += ` LIMIT ? OFFSET ?`;
        params.push(limit, offset ?? 0);
    }
    return await getLibrariesDb().prepare(sql).all(...params) as MediaRow[];
}

export async function countMediaOfUser(userId: string): Promise<number> {
    const row = await getLibrariesDb().prepare(`SELECT COUNT(*) AS count FROM library_entries WHERE userId = ?`).get(userId) as { count: number };
    return Number(row.count);
}

// one AlbumRow per distinct albumId (release-group MBID) owned by the user, aggregated from their media rows;
// grouping must key off albumId (not the display title) since SQLite returns an arbitrary row's value for any
// selected column that isn't in GROUP BY or wrapped in an aggregate, which made `id`/`mbId` nondeterministic
export async function getAlbumsOfUser(userId: string, limit?: number, offset?: number): Promise<AlbumRow[]> {
    let sql = `
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
        ORDER BY MAX(media.addedAt) DESC
    `;
    const params: unknown[] = [userId];
    if (limit !== undefined) {
        sql += ` LIMIT ? OFFSET ?`;
        params.push(limit, offset ?? 0);
    }

    const rows = await getLibrariesDb().prepare(sql).all(...params) as (AlbumRow & { duration: string | number })[];
    // see getTotalMediaSize: mysql2 returns SUM() as a string
    return rows.map((row) => ({ ...row, duration: Number(row.duration) }));
}

export async function countAlbumsOfUser(userId: string): Promise<number> {
    const row = await getLibrariesDb().prepare(`
        SELECT COUNT(DISTINCT media.albumId) AS count
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.album IS NOT NULL AND media.albumId IS NOT NULL AND media.albumId != 'unknown-album'
    `).get(userId) as { count: number };
    return Number(row.count);
}

// total bytes across every distinct media row (the shared pool, not per-user)
export async function getTotalMediaSize(): Promise<number> {
    // mysql2 returns SUM() as a string (it promotes to DECIMAL/BIGINT to avoid precision loss), so cast explicitly -
    // leaving it as a string here causes silent string concatenation wherever this value is later added to another
    const row = await getLibrariesDb().prepare(`SELECT SUM(fileSize) AS total FROM media`).get() as { total: string | number | null };
    return Number(row.total ?? 0);
}

// bytes owned per user, summed across their library entries (a shared track counts for each owner)
export async function getStorageByUser(): Promise<{ userId: string, bytes: number }[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT library_entries.userId AS userId, SUM(media.fileSize) AS bytes
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        GROUP BY library_entries.userId
    `).all() as { userId: string, bytes: string | number }[];
    // see getTotalMediaSize: mysql2 returns SUM() as a string, cast before callers accumulate these
    return rows.map((row) => ({ userId: row.userId, bytes: Number(row.bytes) }));
}

export async function updateMediaFileSize(mediaId: string, fileSize: number): Promise<void> {
    await getLibrariesDb().prepare(`UPDATE media SET fileSize = ? WHERE id = ?`).run(fileSize, mediaId);
}

// every media row plus the userIds that own a library entry for it, for the MANAGE_MUSIC "everyone's library" view
export async function getAllMediaWithOwners(limit?: number, offset?: number): Promise<(MediaRow & { ownerIds: string[] })[]> {
    let sql = `SELECT * FROM media ORDER BY addedAt DESC`;
    const params: unknown[] = [];
    if (limit !== undefined) {
        sql += ` LIMIT ? OFFSET ?`;
        params.push(limit, offset ?? 0);
    }

    const media = await getLibrariesDb().prepare(sql).all(...params) as MediaRow[];
    if (media.length === 0) return [];

    // only pull ownership for the media rows on this page, not the whole table
    const placeholders = media.map(() => "?").join(", ");
    const entries = await getLibrariesDb().prepare(`
        SELECT userId, mediaId FROM library_entries WHERE mediaId IN (${placeholders})
    `).all(...media.map((m) => m.id)) as { userId: string, mediaId: string }[];

    const ownersByMedia = new Map<string, string[]>();
    for (const entry of entries) {
        const list = ownersByMedia.get(entry.mediaId) ?? [];
        list.push(entry.userId);
        ownersByMedia.set(entry.mediaId, list);
    }

    return media.map((row) => ({ ...row, ownerIds: ownersByMedia.get(row.id) ?? [] }));
}

export async function countAllMedia(): Promise<number> {
    const row = await getLibrariesDb().prepare(`SELECT COUNT(*) AS count FROM media`).get() as { count: number };
    return Number(row.count);
}

export async function getMediaId(mediaId: string): Promise<MediaRow | undefined> {
    const row = await getLibrariesDb().prepare(`SELECT * FROM media WHERE id = ? LIMIT 1`).get(mediaId) as MediaRow | undefined;
    return row;
}

// grants `userId` access to an already-downloaded song, no file copy needed since all users share the one file on disk
export async function shareMediaWithUser(userId: string, media: MediaRow, sharedFilePath: string): Promise<LibraryEntry> {
    return addLibraryEntry(userId, media.id, sharedFilePath);
}

// filesystem-illegal / awkward characters stripped from an album or track name before it becomes a path segment
function sanitizePathSegment(name: string): string {
    // eslint-disable-next-line no-control-regex -- deliberately strips control characters too, not just visible punctuation
    const cleaned = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
    return cleaned.slice(0, 200) || "Unknown";
}

// music/{album}/{track title}.ext - so the library reads as a normal folder-of-albums when browsed directly
// (e.g. shared back out via slskd). Falls back to the artist name for albumless singles, and disambiguates
// same-named tracks within an album with a " (2)", " (3)", ... suffix instead of overwriting one another.
export function libraryFilePath(album: string | null, artistName: string, title: string, extension: string): string {
    const albumDir = sanitizePathSegment(album ?? artistName);
    const baseName = sanitizePathSegment(title);
    const dir = join(process.cwd(), "music", albumDir);

    let candidate = `${baseName}${extension}`;
    for (let n = 2; existsSync(join(dir, candidate)); n++) {
        candidate = `${baseName} (${n})${extension}`;
    }

    return join(dir, candidate);
}

// revokes every library entry a user has, used when an account is deleted so no orphaned entries linger
export async function deleteAllLibraryEntriesForUser(userId: string): Promise<void> {
    const media = await getMediaOfUser(userId);
    for (const row of media) {
        await deleteLibraryEntryForUser(userId, row.id);
    }
}

// revokes `userId`'s access to a song; once no user references it anymore, the shared file and media row are deleted too
export async function deleteLibraryEntryForUser(userId: string, mediaId: string): Promise<{ removed: boolean, fileDeleted: boolean }> {
    const entry = await findLibraryEntry(userId, mediaId);
    if (!entry) return { removed: false, fileDeleted: false };

    const db = getLibrariesDb();
    await db.prepare(`DELETE FROM library_entries WHERE id = ?`).run(entry.id);

    const { count } = await db.prepare(`SELECT COUNT(*) AS count FROM library_entries WHERE mediaId = ?`).get(mediaId) as { count: number };
    if (count === 0) {
        await rm(entry.filePath, { force: true });
        // best-effort: drop the album folder once it's the last track in it. rmdir fails (harmlessly)
        // if other tracks still live there, so no need to check first
        await rmdir(dirname(entry.filePath)).catch(() => {});
        await withTransaction(async (conn) => {
            await conn.execute(`DELETE FROM playlist_entries WHERE mediaId = ?`, [mediaId]);
            await conn.execute(`DELETE FROM media WHERE id = ?`, [mediaId]);
        });
        return { removed: true, fileDeleted: true };
    }

    return { removed: true, fileDeleted: false };
}
