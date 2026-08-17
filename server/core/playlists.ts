// custom playlists: owner + collaborating members, entries reference the shared `media` pool directly (not library_entries),
// so a member can add a track to a shared playlist without owning it in their personal library
import { randomUUID } from "node:crypto";
import { getLibrariesDb } from "./db";
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

export function createPlaylist(ownerId: string, title: string, description: string | null, privacy: "public" | "private"): PlaylistRow {
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

    getLibrariesDb().prepare(`
        INSERT INTO playlists (id, ownerId, title, description, privacy, image, sortMode, createdAt, updatedAt)
        VALUES (@id, @ownerId, @title, @description, @privacy, @image, @sortMode, @createdAt, @updatedAt)
    `).run(row);

    return row;
}

export function getPlaylistById(id: string): PlaylistRow | null {
    const row = getLibrariesDb().prepare(`SELECT * FROM playlists WHERE id = ?`).get(id) as PlaylistRow | undefined;
    return row ?? null;
}

// playlists owned by, or shared with, this user
export function getPlaylistsForUser(userId: string): PlaylistRow[] {
    return getLibrariesDb().prepare(`
        SELECT DISTINCT playlists.*
        FROM playlists
        LEFT JOIN playlist_members ON playlist_members.playlistId = playlists.id
        WHERE playlists.ownerId = ? OR playlist_members.userId = ?
        ORDER BY playlists.updatedAt DESC
    `).all(userId, userId) as PlaylistRow[];
}

export function updatePlaylist(id: string, patch: Partial<Pick<PlaylistRow, "title" | "description" | "privacy" | "image" | "sortMode">>): PlaylistRow | null {
    const existing = getPlaylistById(id);
    if (!existing) return null;

    const updated: PlaylistRow = {
        ...existing,
        ...patch,
        updatedAt: Date.now()
    };

    getLibrariesDb().prepare(`
        UPDATE playlists SET title = @title, description = @description, privacy = @privacy, image = @image, sortMode = @sortMode, updatedAt = @updatedAt
        WHERE id = @id
    `).run(updated);

    return updated;
}

export function deletePlaylist(id: string): void {
    const db = getLibrariesDb();
    db.prepare(`DELETE FROM playlist_entries WHERE playlistId = ?`).run(id);
    db.prepare(`DELETE FROM playlist_members WHERE playlistId = ?`).run(id);
    db.prepare(`DELETE FROM playlists WHERE id = ?`).run(id);
}

export function isMember(playlistId: string, userId: string): boolean {
    const row = getLibrariesDb().prepare(`SELECT 1 FROM playlist_members WHERE playlistId = ? AND userId = ?`).get(playlistId, userId);
    return !!row;
}

// true if the user can view/add-to/leave the playlist (owner or invited member)
export function hasAccess(playlist: PlaylistRow, userId: string | null): boolean {
    if (!userId) return false;
    return playlist.ownerId === userId || isMember(playlist.id, userId);
}

export function getMembers(playlistId: string): PlaylistMemberRow[] {
    return getLibrariesDb().prepare(`SELECT * FROM playlist_members WHERE playlistId = ?`).all(playlistId) as PlaylistMemberRow[];
}

export function addMember(playlistId: string, userId: string): PlaylistMemberRow {
    const row: PlaylistMemberRow = {
        id: randomUUID(),
        playlistId,
        userId,
        addedAt: Date.now()
    };

    getLibrariesDb().prepare(`
        INSERT INTO playlist_members (id, playlistId, userId, addedAt)
        VALUES (@id, @playlistId, @userId, @addedAt)
    `).run(row);

    return row;
}

export function removeMember(playlistId: string, userId: string): boolean {
    const result = getLibrariesDb().prepare(`DELETE FROM playlist_members WHERE playlistId = ? AND userId = ?`).run(playlistId, userId);
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

export function getEntries(playlistId: string): PlaylistEntryWithMedia[] {
    const rows = getLibrariesDb().prepare(`
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
    `).all(playlistId) as EntryMediaJoinRow[];

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

export function getEntryById(entryId: string): PlaylistEntryRow | null {
    const row = getLibrariesDb().prepare(`SELECT * FROM playlist_entries WHERE id = ?`).get(entryId) as PlaylistEntryRow | undefined;
    return row ?? null;
}

// appends mediaIds to the end of the playlist in order, used for both single-track and full-album adds
export function addEntries(playlistId: string, mediaIds: string[], addedBy: string): PlaylistEntryRow[] {
    const db = getLibrariesDb();
    const { max } = db.prepare(`SELECT MAX(position) AS max FROM playlist_entries WHERE playlistId = ?`).get(playlistId) as { max: number | null };
    let nextPosition = (max ?? -1) + 1;

    const insert = db.prepare(`
        INSERT INTO playlist_entries (id, playlistId, mediaId, addedBy, position, addedAt)
        VALUES (@id, @playlistId, @mediaId, @addedBy, @position, @addedAt)
    `);

    const now = Date.now();
    const rows: PlaylistEntryRow[] = mediaIds.map((mediaId) => ({
        id: randomUUID(),
        playlistId,
        mediaId,
        addedBy,
        position: nextPosition++,
        addedAt: now
    }));

    db.transaction(() => {
        for (const row of rows) insert.run(row);
    })();

    return rows;
}

export function removeEntry(entryId: string): void {
    getLibrariesDb().prepare(`DELETE FROM playlist_entries WHERE id = ?`).run(entryId);
}

// rewrites position 0..n for the given entry IDs, all of which must belong to playlistId
export function reorderEntries(playlistId: string, orderedEntryIds: string[]): void {
    const db = getLibrariesDb();
    const update = db.prepare(`UPDATE playlist_entries SET position = ? WHERE id = ? AND playlistId = ?`);

    db.transaction(() => {
        orderedEntryIds.forEach((entryId, index) => {
            update.run(index, entryId, playlistId);
        });
    })();
}
