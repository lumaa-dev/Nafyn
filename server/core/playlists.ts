// custom playlists: owner + collaborating members, entries reference the shared `media` pool directly (not library_entries),
// so a member can add a track to a shared playlist without owning it in their personal library
import { randomUUID } from "node:crypto";
import { getLibrariesDb, withTransaction, sqlInt } from "./db";
import type { MediaRow } from "./library";

export type PlaylistSortMode = "manual" | "title" | "artist" | "addedBy" | "duration";

export interface PlaylistRow {
    id: string,
    ownerId: string,
    title: string,
    description: string | null,
    privacy: "public" | "private",
    image: string | null,
    sortMode: PlaylistSortMode,
    createdAt: number,
    updatedAt: number
}

export interface PlaylistMemberRow {
    id: string,
    playlistId: string,
    userId: string,
    addedAt: number
}

export interface PlaylistEntryRow {
    id: string,
    playlistId: string,
    mediaId: string,
    addedBy: string,
    position: number,
    addedAt: number
}

export interface PlaylistEntryWithMedia {
    entryId: string,
    playlistId: string,
    addedBy: string,
    position: number,
    addedAt: number,
    media: MediaRow
}

export async function createPlaylist(ownerId: string, title: string, description: string | null, privacy: "public" | "private"): Promise<PlaylistRow> {
    const now = Date.now();
    const row: PlaylistRow = {
        id: randomUUID(),
        ownerId,
        title,
        description,
        privacy,
        image: null,
        sortMode: "manual",
        createdAt: now,
        updatedAt: now
    };

    await getLibrariesDb().prepare(`
        INSERT INTO playlists (id, ownerId, title, description, privacy, image, sortMode, createdAt, updatedAt)
        VALUES (:id, :ownerId, :title, :description, :privacy, :image, :sortMode, :createdAt, :updatedAt)
    `).run(row);

    return row;
}

export async function getPlaylistById(id: string): Promise<PlaylistRow | null> {
    const row = await getLibrariesDb().prepare(`SELECT * FROM playlists WHERE id = ?`).get(id) as PlaylistRow | undefined;
    return row ?? null;
}

// playlists owned by, or shared with, this user
export async function getPlaylistsForUser(userId: string, limit?: number, offset?: number): Promise<PlaylistRow[]> {
    let sql = `
        SELECT DISTINCT playlists.*
        FROM playlists
        LEFT JOIN playlist_members ON playlist_members.playlistId = playlists.id
        WHERE playlists.ownerId = ? OR playlist_members.userId = ?
        ORDER BY playlists.updatedAt DESC, playlists.id ASC
    `;
    const params: unknown[] = [userId, userId];
    if (limit !== undefined) {
        sql += ` LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset ?? 0)}`;
    }
    return await getLibrariesDb().prepare(sql).all(...params) as PlaylistRow[];
}

export async function countPlaylistsForUser(userId: string): Promise<number> {
    const row = await getLibrariesDb().prepare(`
        SELECT COUNT(DISTINCT playlists.id) AS count
        FROM playlists
        LEFT JOIN playlist_members ON playlist_members.playlistId = playlists.id
        WHERE playlists.ownerId = ? OR playlist_members.userId = ?
    `).get(userId, userId) as { count: number };
    return Number(row.count);
}

export async function updatePlaylist(id: string, patch: Partial<Pick<PlaylistRow, "title" | "description" | "privacy" | "image" | "sortMode">>): Promise<PlaylistRow | null> {
    const existing = await getPlaylistById(id);
    if (!existing) return null;

    const updated: PlaylistRow = {
        ...existing,
        ...patch,
        updatedAt: Date.now()
    };

    await getLibrariesDb().prepare(`
        UPDATE playlists SET title = :title, description = :description, privacy = :privacy, image = :image, sortMode = :sortMode, updatedAt = :updatedAt
        WHERE id = :id
    `).run(updated);

    return updated;
}

export async function deletePlaylist(id: string): Promise<void> {
    const db = getLibrariesDb();
    await db.prepare(`DELETE FROM playlist_entries WHERE playlistId = ?`).run(id);
    await db.prepare(`DELETE FROM playlist_members WHERE playlistId = ?`).run(id);
    await db.prepare(`DELETE FROM playlists WHERE id = ?`).run(id);
}

export async function isMember(playlistId: string, userId: string): Promise<boolean> {
    const row = await getLibrariesDb().prepare(`SELECT 1 FROM playlist_members WHERE playlistId = ? AND userId = ?`).get(playlistId, userId);
    return !!row;
}

// true if the user can view/add-to/leave the playlist (owner or invited member)
export async function hasAccess(playlist: PlaylistRow, userId: string | null): Promise<boolean> {
    if (!userId) return false;
    return playlist.ownerId === userId || await isMember(playlist.id, userId);
}

export async function getMembers(playlistId: string): Promise<PlaylistMemberRow[]> {
    return await getLibrariesDb().prepare(`SELECT * FROM playlist_members WHERE playlistId = ?`).all(playlistId) as PlaylistMemberRow[];
}

export async function addMember(playlistId: string, userId: string): Promise<PlaylistMemberRow> {
    const row: PlaylistMemberRow = {
        id: randomUUID(),
        playlistId,
        userId,
        addedAt: Date.now()
    };

    await getLibrariesDb().prepare(`
        INSERT INTO playlist_members (id, playlistId, userId, addedAt)
        VALUES (:id, :playlistId, :userId, :addedAt)
    `).run(row);

    return row;
}

export async function removeMember(playlistId: string, userId: string): Promise<boolean> {
    const result = await getLibrariesDb().prepare(`DELETE FROM playlist_members WHERE playlistId = ? AND userId = ?`).run(playlistId, userId);
    return result.changes > 0;
}

interface EntryMediaJoinRow {
    entryId: string,
    playlistId: string,
    addedBy: string,
    position: number,
    addedAt: number,
    mediaId: string,
    musicbrainzId: string,
    title: string,
    artistName: string,
    artistMbid: string,
    album: string | null,
    albumId: string,
    albumType: "album" | "ep" | null,
    coverArt: string | null,
    releaseDate: number | null,
    duration: number,
    label: string | null,
    fingerprint: string | null,
    amId: string | null,
    mediaAddedAt: number
}

export async function getEntries(playlistId: string, limit?: number, offset?: number): Promise<PlaylistEntryWithMedia[]> {
    let sql = `
        SELECT
            playlist_entries.id AS entryId,
            playlist_entries.playlistId AS playlistId,
            playlist_entries.addedBy AS addedBy,
            playlist_entries.position AS position,
            playlist_entries.addedAt AS addedAt,
            media.id AS mediaId,
            media.musicbrainzId AS musicbrainzId,
            media.title AS title,
            media.artistName AS artistName,
            media.artistMbid AS artistMbid,
            media.album AS album,
            media.albumId AS albumId,
            media.albumType AS albumType,
            media.coverArt AS coverArt,
            media.releaseDate AS releaseDate,
            media.duration AS duration,
            media.label AS label,
            media.fingerprint AS fingerprint,
            media.amId AS amId,
            media.addedAt AS mediaAddedAt
        FROM playlist_entries
        JOIN media ON media.id = playlist_entries.mediaId
        WHERE playlist_entries.playlistId = ?
        ORDER BY playlist_entries.position ASC
    `;
    const params: unknown[] = [playlistId];
    if (limit !== undefined) {
        sql += ` LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset ?? 0)}`;
    }

    const rows = await getLibrariesDb().prepare(sql).all(...params) as EntryMediaJoinRow[];

    return rows.map((row) => ({
        entryId: row.entryId,
        playlistId: row.playlistId,
        addedBy: row.addedBy,
        position: row.position,
        addedAt: row.addedAt,
        media: {
            id: row.mediaId,
            musicbrainzId: row.musicbrainzId,
            title: row.title,
            artistName: row.artistName,
            artistMbid: row.artistMbid,
            album: row.album,
            albumId: row.albumId,
            albumType: row.albumType,
            coverArt: row.coverArt,
            releaseDate: row.releaseDate,
            duration: row.duration,
            label: row.label,
            fingerprint: row.fingerprint,
            amId: row.amId,
            addedAt: row.mediaAddedAt
        }
    }));
}

export async function countEntries(playlistId: string): Promise<number> {
    const row = await getLibrariesDb().prepare(`SELECT COUNT(*) AS count FROM playlist_entries WHERE playlistId = ?`).get(playlistId) as { count: number };
    return Number(row.count);
}

export async function getEntryById(entryId: string): Promise<PlaylistEntryRow | null> {
    const row = await getLibrariesDb().prepare(`SELECT * FROM playlist_entries WHERE id = ?`).get(entryId) as PlaylistEntryRow | undefined;
    return row ?? null;
}

// appends mediaIds to the end of the playlist in order, used for both single-track and full-album adds
export async function addEntries(playlistId: string, mediaIds: string[], addedBy: string): Promise<PlaylistEntryRow[]> {
    const db = getLibrariesDb();
    const { max } = await db.prepare(`SELECT MAX(position) AS max FROM playlist_entries WHERE playlistId = ?`).get(playlistId) as { max: number | null };
    let nextPosition = (max ?? -1) + 1;

    const insertSql = `
        INSERT INTO playlist_entries (id, playlistId, mediaId, addedBy, position, addedAt)
        VALUES (:id, :playlistId, :mediaId, :addedBy, :position, :addedAt)
    `;

    const now = Date.now();
    const rows: PlaylistEntryRow[] = mediaIds.map((mediaId) => ({
        id: randomUUID(),
        playlistId,
        mediaId,
        addedBy,
        position: nextPosition++,
        addedAt: now
    }));

    await withTransaction(async (conn) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const row of rows) await conn.execute(insertSql, row as any);
    });

    return rows;
}

export async function removeEntry(entryId: string): Promise<void> {
    await getLibrariesDb().prepare(`DELETE FROM playlist_entries WHERE id = ?`).run(entryId);
}

// rewrites position 0..n for the given entry IDs, all of which must belong to playlistId
export async function reorderEntries(playlistId: string, orderedEntryIds: string[]): Promise<void> {
    const updateSql = `UPDATE playlist_entries SET position = ? WHERE id = ? AND playlistId = ?`;

    await withTransaction(async (conn) => {
        for (const [index, entryId] of orderedEntryIds.entries()) {
            await conn.execute(updateSql, [index, entryId, playlistId]);
        }
    });
}
