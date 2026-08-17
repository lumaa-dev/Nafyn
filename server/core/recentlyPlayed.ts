// per-user "recently played" shelf: tracks, albums, and playlists are recorded from wherever
// playback was started from (see usePlayer.play()'s optional `context` argument), deduplicated
// per (user, type, refId) and capped at MAX_ENTRIES most recent
import { randomUUID } from "node:crypto";
import { getLibrariesDb } from "./db";

export type RecentlyPlayedType = "track" | "album" | "playlist";

export interface RecentlyPlayedRow {
    id: string,
    userId: string,
    type: RecentlyPlayedType,
    refId: string,
    playedAt: number
}

export interface RecentlyPlayedEntry {
    type: RecentlyPlayedType,
    refId: string,
    playedAt: number,
    title: string,
    subtitle: string | null,
    coverArt: string | null,
    // only set for type "playlist" - the raw image version stamp, since the actual image URL needs a
    // caller-supplied auth token query param (see playlist image.get.ts), which this module has no access to
    playlistImage: string | null,
    href: string
}

const MAX_ENTRIES = 20;

export function recordRecentlyPlayed(userId: string, type: RecentlyPlayedType, refId: string): void {
    const db = getLibrariesDb();
    const row: RecentlyPlayedRow = { id: randomUUID(), userId, type, refId, playedAt: Date.now() };

    db.prepare(`
        INSERT INTO recently_played (id, userId, type, refId, playedAt)
        VALUES (@id, @userId, @type, @refId, @playedAt)
        ON CONFLICT(userId, type, refId) DO UPDATE SET playedAt = excluded.playedAt
    `).run(row);

    db.prepare(`
        DELETE FROM recently_played
        WHERE userId = ? AND id NOT IN (
            SELECT id FROM recently_played WHERE userId = ? ORDER BY playedAt DESC LIMIT ?
        )
    `).run(userId, userId, MAX_ENTRIES);
}

interface TrackAlbumJoinRow {
    refId: string,
    playedAt: number,
    title: string | null,
    subtitle: string | null,
    coverArt: string | null
}

export function getRecentlyPlayed(userId: string): RecentlyPlayedEntry[] {
    const db = getLibrariesDb();
    const rows = db.prepare(`
        SELECT * FROM recently_played WHERE userId = ? ORDER BY playedAt DESC LIMIT ?
    `).all(userId, MAX_ENTRIES) as RecentlyPlayedRow[];

    const entries: RecentlyPlayedEntry[] = [];

    for (const row of rows) {
        if (row.type === "track") {
            const media = db.prepare(`
                SELECT media.musicbrainzId AS refId, media.title AS title, media.artistName AS subtitle, media.coverArt AS coverArt
                FROM media WHERE media.id = ?
            `).get(row.refId) as TrackAlbumJoinRow | undefined;
            if (!media?.title) continue;

            entries.push({
                type: "track",
                refId: row.refId,
                playedAt: row.playedAt,
                title: media.title,
                subtitle: media.subtitle,
                coverArt: media.coverArt,
                playlistImage: null,
                href: `/t/${media.refId}`
            });
        } else if (row.type === "album") {
            const album = db.prepare(`
                SELECT
                    MIN(media.album) AS title,
                    MIN(media.artistName) AS subtitle,
                    MIN(media.coverArt) AS coverArt
                FROM library_entries
                JOIN media ON media.id = library_entries.mediaId
                WHERE library_entries.userId = ? AND media.albumId = ?
                GROUP BY media.albumId
            `).get(userId, row.refId) as Omit<TrackAlbumJoinRow, "refId"> | undefined;
            if (!album?.title) continue;

            entries.push({
                type: "album",
                refId: row.refId,
                playedAt: row.playedAt,
                title: album.title,
                subtitle: album.subtitle,
                coverArt: album.coverArt,
                playlistImage: null,
                href: `/a/${row.refId}`
            });
        } else {
            const playlist = db.prepare(`SELECT title, image FROM playlists WHERE id = ?`).get(row.refId) as { title: string, image: string | null } | undefined;
            if (!playlist) continue;

            entries.push({
                type: "playlist",
                refId: row.refId,
                playedAt: row.playedAt,
                title: playlist.title,
                subtitle: null,
                coverArt: null,
                playlistImage: playlist.image,
                href: `/l/playlist/${row.refId}`
            });
        }
    }

    return entries;
}
