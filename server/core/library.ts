// per-user music library: shared `media` metadata rows + shared audio file on disk, `library_entries` only grants per-user access
import { randomUUID, UUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getLibrariesDb, withTransaction, sqlInt } from "./db";

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
    // earliest addedAt among the album's tracks - not a MusicBrainz field, but a stable "added to Nafyn"
    // timestamp callers can fall back on (e.g. Subsonic's `created` when there's no real releaseDate)
    // instead of the current time, which would make the album look freshly-changed on every single fetch
    addedAt: number
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
    // secondary `id` tiebreaker: addedAt alone isn't unique (rows added in the same batch/millisecond
    // sort arbitrarily against each other), so without it repeated LIMIT/OFFSET calls - e.g. a Subsonic
    // client re-syncing - can return overlapping/duplicate pages instead of a stable partition
    let sql = `
        SELECT media.*
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ?
        ORDER BY media.addedAt DESC, media.id ASC
    `;
    const params: unknown[] = [userId];
    if (limit !== undefined) {
        sql += ` LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset ?? 0)}`;
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
            COUNT(*) AS trackCount,
            MIN(media.addedAt) AS addedAt
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.album IS NOT NULL AND media.albumId IS NOT NULL AND media.albumId != 'unknown-album'
        GROUP BY media.albumId
        ORDER BY MAX(media.addedAt) DESC, media.albumId ASC
    `;
    const params: unknown[] = [userId];
    if (limit !== undefined) {
        sql += ` LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset ?? 0)}`;
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

// single AlbumRow for one albumId, scoped to what the user owns - used by the Subsonic layer's getAlbum
export async function getAlbumOfUser(userId: string, albumId: string): Promise<AlbumRow | null> {
    const row = await getLibrariesDb().prepare(`
        SELECT
            media.albumId AS id,
            MIN(media.musicbrainzId) AS mbId,
            MIN(media.album) AS title,
            MIN(media.artistName) AS artistName,
            MIN(media.artistMbid) AS artistMbid,
            MIN(media.coverArt) AS coverArt,
            MIN(media.releaseDate) AS releaseDate,
            SUM(media.duration) AS duration,
            COUNT(*) AS trackCount,
            MIN(media.addedAt) AS addedAt
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.albumId = ?
        GROUP BY media.albumId
    `).get(userId, albumId) as (AlbumRow & { duration: string | number }) | undefined;
    return row ? { ...row, duration: Number(row.duration) } : null;
}

// a MediaRow plus the caller's own filePath for it - filePath lives on library_entries (per-owner), not
// media (shared pool), and the Subsonic layer needs it for content-type/size/streaming
export type SubsonicSong = MediaRow & { filePath: string };

// every owned track from one album, for the Subsonic layer's getAlbum - track order falls back to title
// since trackNumber is only ever embedded in the audio file's own tags, never persisted on the media row
export async function getAlbumSongsOfUser(userId: string, albumId: string): Promise<SubsonicSong[]> {
    return await getLibrariesDb().prepare(`
        SELECT media.*, library_entries.filePath AS filePath
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.albumId = ?
        ORDER BY media.title ASC, media.id ASC
    `).all(userId, albumId) as SubsonicSong[];
}

// single owned track by media ID, for the Subsonic layer's getSong/stream/download
export async function getSongOfUser(userId: string, mediaId: string): Promise<SubsonicSong | null> {
    const row = await getLibrariesDb().prepare(`
        SELECT media.*, library_entries.filePath AS filePath
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.id = ?
    `).get(userId, mediaId) as SubsonicSong | undefined;
    return row ?? null;
}

export interface ArtistRow {
    id: string,
    name: string,
    albumCount: number
}

// one ArtistRow per distinct artist owned by the user - grouped by artistMbid where known, falling back to
// the display name for tracks with no MusicBrainz artist credit, so those still collect under one entry
export async function getArtistsOfUser(userId: string): Promise<ArtistRow[]> {
    return await getLibrariesDb().prepare(`
        SELECT
            COALESCE(media.artistMbid, media.artistName) AS id,
            MIN(media.artistName) AS name,
            COUNT(DISTINCT media.albumId) AS albumCount
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ?
        GROUP BY COALESCE(media.artistMbid, media.artistName)
        ORDER BY name ASC
    `).all(userId) as ArtistRow[];
}

// single ArtistRow (see getArtistsOfUser for the id scheme), scoped to what the user owns
export async function getArtistOfUser(userId: string, artistId: string): Promise<ArtistRow | null> {
    const row = await getLibrariesDb().prepare(`
        SELECT
            COALESCE(media.artistMbid, media.artistName) AS id,
            MIN(media.artistName) AS name,
            COUNT(DISTINCT media.albumId) AS albumCount
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND COALESCE(media.artistMbid, media.artistName) = ?
        GROUP BY COALESCE(media.artistMbid, media.artistName)
    `).get(userId, artistId) as ArtistRow | undefined;
    return row ?? null;
}

// albums by one artist (see getArtistsOfUser for the id scheme), scoped to what the user owns
export async function getArtistAlbumsOfUser(userId: string, artistId: string): Promise<AlbumRow[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT
            media.albumId AS id,
            MIN(media.musicbrainzId) AS mbId,
            MIN(media.album) AS title,
            MIN(media.artistName) AS artistName,
            MIN(media.artistMbid) AS artistMbid,
            MIN(media.coverArt) AS coverArt,
            MIN(media.releaseDate) AS releaseDate,
            SUM(media.duration) AS duration,
            COUNT(*) AS trackCount,
            MIN(media.addedAt) AS addedAt
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND COALESCE(media.artistMbid, media.artistName) = ?
          AND media.album IS NOT NULL AND media.albumId IS NOT NULL AND media.albumId != 'unknown-album'
        GROUP BY media.albumId
        ORDER BY MIN(media.releaseDate) ASC
    `).all(userId, artistId) as (AlbumRow & { duration: string | number })[];
    return rows.map((row) => ({ ...row, duration: Number(row.duration) }));
}

export type AlbumListSort = "newest" | "alphabeticalByName" | "alphabeticalByArtist" | "random";

// paged album listing for the Subsonic layer's getAlbumList2 - "frequent"/"recent"/"starred" etc. from the
// real protocol aren't tracked by Nafyn (no per-album play counts or starring yet), so callers requesting an
// unsupported sort fall back to "newest" rather than erroring
export async function getAlbumListOfUser(userId: string, sort: AlbumListSort, limit: number, offset: number): Promise<AlbumRow[]> {
    // every mode but "random" gets an albumId tiebreaker - without one, ties (e.g. many albums added in the
    // same download batch share one addedAt) sort arbitrarily against each other, so repeated LIMIT/OFFSET
    // calls (a Subsonic client re-syncing via getAlbumList2) can return overlapping pages: the same album
    // shows up twice, another gets skipped. "random" is deliberately different on every call, so it's exempt.
    const orderBy = sort === "alphabeticalByName" ? "MIN(media.album) ASC, media.albumId ASC"
        : sort === "alphabeticalByArtist" ? "MIN(media.artistName) ASC, media.albumId ASC"
        : sort === "random" ? "RAND()"
        : "MAX(media.addedAt) DESC, media.albumId ASC";

    const rows = await getLibrariesDb().prepare(`
        SELECT
            media.albumId AS id,
            MIN(media.musicbrainzId) AS mbId,
            MIN(media.album) AS title,
            MIN(media.artistName) AS artistName,
            MIN(media.artistMbid) AS artistMbid,
            MIN(media.coverArt) AS coverArt,
            MIN(media.releaseDate) AS releaseDate,
            SUM(media.duration) AS duration,
            COUNT(*) AS trackCount,
            MIN(media.addedAt) AS addedAt
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.album IS NOT NULL AND media.albumId IS NOT NULL AND media.albumId != 'unknown-album'
        GROUP BY media.albumId
        ORDER BY ${orderBy}
        LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}
    `).all(userId) as (AlbumRow & { duration: string | number })[];
    return rows.map((row) => ({ ...row, duration: Number(row.duration) }));
}

export interface LibrarySearchResults {
    artists: ArtistRow[],
    albums: AlbumRow[],
    songs: SubsonicSong[]
}

// Subsonic search3: a simple substring match across the user's own library, not a MusicBrainz lookup -
// search here means "find something I've already downloaded", same as the in-app library search
export async function searchLibraryOfUser(userId: string, query: string, artistCount: number, albumCount: number, songCount: number): Promise<LibrarySearchResults> {
    const db = getLibrariesDb();
    // `query` reaches here already escaped for LIKE (see escapeLike in server/utils/ids.ts) so a search for
    // "%" matches a literal percent sign instead of every row in the table. The explicit ESCAPE below makes
    // that escaping hold regardless of the server's NO_BACKSLASH_ESCAPES sql_mode.
    const like = `%${query}%`;

    const artists = await db.prepare(`
        SELECT
            COALESCE(media.artistMbid, media.artistName) AS id,
            MIN(media.artistName) AS name,
            COUNT(DISTINCT media.albumId) AS albumCount
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.artistName LIKE ? ESCAPE '\\'
        GROUP BY COALESCE(media.artistMbid, media.artistName)
        ORDER BY name ASC, id ASC
        LIMIT ${sqlInt(artistCount)}
    `).all(userId, like) as ArtistRow[];

    const albumRows = await db.prepare(`
        SELECT
            media.albumId AS id,
            MIN(media.musicbrainzId) AS mbId,
            MIN(media.album) AS title,
            MIN(media.artistName) AS artistName,
            MIN(media.artistMbid) AS artistMbid,
            MIN(media.coverArt) AS coverArt,
            MIN(media.releaseDate) AS releaseDate,
            SUM(media.duration) AS duration,
            COUNT(*) AS trackCount,
            MIN(media.addedAt) AS addedAt
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.album LIKE ? ESCAPE '\\'
          AND media.albumId IS NOT NULL AND media.albumId != 'unknown-album'
        GROUP BY media.albumId
        ORDER BY MIN(media.album) ASC, media.albumId ASC
        LIMIT ${sqlInt(albumCount)}
    `).all(userId, like) as (AlbumRow & { duration: string | number })[];

    const songs = await db.prepare(`
        SELECT media.*, library_entries.filePath AS filePath
        FROM library_entries
        JOIN media ON media.id = library_entries.mediaId
        WHERE library_entries.userId = ? AND media.title LIKE ? ESCAPE '\\'
        ORDER BY media.title ASC, media.id ASC
        LIMIT ${sqlInt(songCount)}
    `).all(userId, like) as SubsonicSong[];

    return {
        artists,
        albums: albumRows.map((row) => ({ ...row, duration: Number(row.duration) })),
        songs
    };
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
    let sql = `SELECT * FROM media ORDER BY addedAt DESC, id ASC`;
    if (limit !== undefined) {
        sql += ` LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset ?? 0)}`;
    }

    const media = await getLibrariesDb().prepare(sql).all() as MediaRow[];
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
