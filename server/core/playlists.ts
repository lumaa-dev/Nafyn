// custom playlists: owner + collaborating members, entries reference the shared `media` pool directly (not library_entries),
// so a member can add a track to a shared playlist without owning it in their personal library
import { randomUUID } from "node:crypto";
import { getLibrariesDb, withTransaction, sqlInt } from "./db";
import type { MediaRow } from "./library";
import { assertNotReplayPlaylist } from "./replayMix";

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
    /** only meaningful when the entries were read for a viewer (getEntries' `viewerId`) */
    inLibrary?: boolean,
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

// Every mutator below starts with assertNotReplayPlaylist(). Today that guard is unreachable - a Replay Mix
// lives in user_replay_playlists, never in `playlists`, so a replay id can't resolve to a row here in the
// first place. It exists so that the day someone mirrors the mix into this table for convenience, the
// "unmodifiable by anyone, user or admin" guarantee doesn't quietly evaporate. Guarding in core rather than
// in the seven route handlers means one implementation covers the REST API and the Subsonic layer at once.
export async function updatePlaylist(id: string, patch: Partial<Pick<PlaylistRow, "title" | "description" | "privacy" | "image" | "sortMode">>): Promise<PlaylistRow | null> {
    assertNotReplayPlaylist(id);
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
    assertNotReplayPlaylist(id);
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
    assertNotReplayPlaylist(playlistId);
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
    assertNotReplayPlaylist(playlistId);
    const result = await getLibrariesDb().prepare(`DELETE FROM playlist_members WHERE playlistId = ? AND userId = ?`).run(playlistId, userId);
    return result.changes > 0;
}

type EntryMediaJoinRow = MediaRow & {
    entryId: string,
    entryPlaylistId: string,
    entryAddedBy: string,
    entryPosition: number,
    entryAddedAt: number,
    inLibrary?: number | string
};

// The entries of a playlist, each with its whole media row (file size, disc, uploaded cover... - a playlist row
// must look like the same track anywhere else it is shown). With `viewerId`, each also says whether that user
// has the track in their own library: a collaborator's playlist holds tracks they never downloaded, and the
// client uses the flag to offer only what applies (no "delete from my library" for a track that isn't).
export async function getEntries(playlistId: string, limit?: number, offset?: number, viewerId?: string): Promise<PlaylistEntryWithMedia[]> {
    const inLibrary = viewerId
        ? `EXISTS (SELECT 1 FROM library_entries le WHERE le.mediaId = media.id AND le.userId = ?) AS inLibrary`
        : `0 AS inLibrary`;
    let sql = `
        SELECT
            playlist_entries.id AS entryId,
            playlist_entries.playlistId AS entryPlaylistId,
            playlist_entries.addedBy AS entryAddedBy,
            playlist_entries.position AS entryPosition,
            playlist_entries.addedAt AS entryAddedAt,
            ${inLibrary},
            media.*
        FROM playlist_entries
        JOIN media ON media.id = playlist_entries.mediaId
        WHERE playlist_entries.playlistId = ?
        ORDER BY playlist_entries.position ASC
    `;
    const params: unknown[] = viewerId ? [viewerId, playlistId] : [playlistId];
    if (limit !== undefined) {
        sql += ` LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset ?? 0)}`;
    }

    const rows = await getLibrariesDb().prepare(sql).all(...params) as EntryMediaJoinRow[];

    return rows.map((row) => {
        const { entryId, entryPlaylistId, entryAddedBy, entryPosition, entryAddedAt, inLibrary: owned, ...media } = row;
        return {
            entryId,
            playlistId: entryPlaylistId,
            addedBy: entryAddedBy,
            position: entryPosition,
            addedAt: Number(entryAddedAt),
            inLibrary: Number(owned) === 1,
            media: media as MediaRow
        };
    });
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
    assertNotReplayPlaylist(playlistId);
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

// no assertNotReplayPlaylist here: this takes an *entry* id, not a playlist id, and a Replay Mix has no rows
// in playlist_entries to hand one out. The route that calls it resolves the entry's playlist first, and that
// lookup is where a replay id would already fail.
export async function removeEntry(entryId: string): Promise<void> {
    await getLibrariesDb().prepare(`DELETE FROM playlist_entries WHERE id = ?`).run(entryId);
}

// rewrites position 0..n for the given entry IDs, all of which must belong to playlistId
export async function reorderEntries(playlistId: string, orderedEntryIds: string[]): Promise<void> {
    assertNotReplayPlaylist(playlistId);
    const updateSql = `UPDATE playlist_entries SET position = ? WHERE id = ? AND playlistId = ?`;

    await withTransaction(async (conn) => {
        for (const [index, entryId] of orderedEntryIds.entries()) {
            await conn.execute(updateSql, [index, entryId, playlistId]);
        }
    });
}

// ---- erasure helpers (GDPR art. 17) ---------------------------------------------------------------------
//
// Called from eraseAccount() in accountErasure.ts. Playlists split three ways on account deletion:
// the ones the account owns are deleted outright, its memberships in other people's playlists are dropped,
// and entries it added to playlists it does not own are anonymized rather than deleted - removing them
// would silently delete tracks out of a playlist that still belongs to somebody else.

export async function listPlaylistsOwnedBy(ownerId: string): Promise<PlaylistRow[]> {
    return await getLibrariesDb().prepare(`SELECT * FROM playlists WHERE ownerId = ?`).all(ownerId) as PlaylistRow[];
}

export async function listMembershipsOfUser(userId: string): Promise<PlaylistMemberRow[]> {
    return await getLibrariesDb().prepare(`SELECT * FROM playlist_members WHERE userId = ?`).all(userId) as PlaylistMemberRow[];
}

export async function removeAllMembershipsOfUser(userId: string): Promise<number> {
    const result = await getLibrariesDb().prepare(`DELETE FROM playlist_members WHERE userId = ?`).run(userId);
    return result.changes;
}

// `addedBy` is NOT NULL, so the identifier is replaced with a sentinel instead of nulled. It is deliberately
// not a UUID: nothing can ever resolve it back to an account, and getUserById() returns null for it, which
// every reader of `addedBy` already handles (GET /api/v1/playlist/{pid} returns it as null).
export const DELETED_USER_SENTINEL = "deleted";

export async function anonymizeEntriesAddedBy(userId: string): Promise<number> {
    const result = await getLibrariesDb().prepare(`
        UPDATE playlist_entries SET addedBy = ? WHERE addedBy = ?
    `).run(DELETED_USER_SENTINEL, userId);
    return result.changes;
}

// Anonymous visitors may view public playlists, so the covers of the tracks in them have to load without a
// token. These two answer "is this cover part of some public playlist": the cover routes serve it to a
// visitor only then, which keeps them from being an open proxy to the Cover Art Archive / the uploaded files.
// `id` is a validated UUID (no LIKE wildcards).
export async function isCoverArtInPublicPlaylist(kind: "release" | "release-group", id: string): Promise<boolean> {
    const row = await getLibrariesDb().prepare(`
        SELECT 1 FROM playlists p
        JOIN playlist_entries e ON e.playlistId = p.id
        JOIN media m ON m.id = e.mediaId
        WHERE p.privacy = 'public' AND m.coverArt LIKE ?
        LIMIT 1
    `).get(`https://coverartarchive.org/${kind}/${id.toLowerCase()}/%`);
    return !!row;
}

export async function isCustomCoverInPublicPlaylist(mediaId: string): Promise<boolean> {
    const row = await getLibrariesDb().prepare(`
        SELECT 1 FROM playlists p
        JOIN playlist_entries e ON e.playlistId = p.id
        WHERE p.privacy = 'public' AND e.mediaId = ?
        LIMIT 1
    `).get(mediaId);
    return !!row;
}

export interface PublicPlaylistSummary {
    id: string,
    title: string,
    description: string | null,
    image: string | null,
    trackCount: number,
    updatedAt: number
}

// the public playlists a user owns, for their public profile page (playlists they only collaborate on are not
// theirs to advertise)
export async function listPublicPlaylistsOwnedBy(ownerId: string): Promise<PublicPlaylistSummary[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT p.id, p.title, p.description, p.image, p.updatedAt,
               (SELECT COUNT(*) FROM playlist_entries e WHERE e.playlistId = p.id) AS trackCount
        FROM playlists p
        WHERE p.ownerId = ? AND p.privacy = 'public'
        ORDER BY p.updatedAt DESC, p.id ASC
    `).all(ownerId) as (Omit<PublicPlaylistSummary, "trackCount"> & { trackCount: string | number })[];
    return rows.map((row) => ({ ...row, trackCount: Number(row.trackCount), updatedAt: Number(row.updatedAt) }));
}
