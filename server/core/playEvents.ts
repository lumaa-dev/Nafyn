// the append-only play-event store.
//
// Rows here are only ever inserted (idempotently, keyed on a client-minted event_id) or deleted wholesale at
// the user's request. Nothing updates a play event: it is a record of something that happened, and the
// aggregates in insightsAggregate.ts are derived from it rather than the other way round.
import { getLibrariesDb, withTransaction, sqlInt } from "./db";
import type { PlayEventInput } from "~~/server/utils/insightsValidate";
import { toMysqlDateTime } from "~~/server/utils/insightsPeriod";

// media.albumId is nullable and already uses this sentinel elsewhere in the codebase for tracks with no
// resolved release group; play_events.album_id is NOT NULL, so the sentinel is the fallback here too
const UNKNOWN_ALBUM = "unknown-album";

export interface PlayEventRow {
    event_id: string,
    user_id: string,
    track_id: string,
    album_id: string,
    artist_id: string | null,
    playlist_id: string | null,
    started_at: Date,
    duration_ms: number,
    completed: number,
    source: string,
    created_at: Date
}

interface TrackMeta {
    id: string,
    albumId: string | null,
    artistMbid: string | null,
    duration: number
}

/**
 * Resolves the album and artist for each track from the `media` table, and drops any event whose track the
 * user has no library entry for.
 *
 * Both halves matter for correctness *and* for security. A client that names its own album/artist could
 * otherwise fabricate a "top artist" out of nothing, so the server ignores whatever it sent and resolves
 * from the media row. And gating on library_entries means a user can only log plays of tracks they can
 * actually stream - without it, POSTing arbitrary media ids would both pollute their own stats and let them
 * probe which media ids exist on the server.
 */
async function enrichEvents(userId: string, events: PlayEventInput[]): Promise<{ event: PlayEventInput, meta: TrackMeta }[]> {
    if (events.length === 0) return [];

    const trackIds = [...new Set(events.map((e) => e.trackId))];
    const placeholders = trackIds.map(() => "?").join(", ");

    const rows = await getLibrariesDb().prepare(`
        SELECT m.id, m.albumId, m.artistMbid, m.duration
        FROM media m
        JOIN library_entries le ON le.mediaId = m.id AND le.userId = ?
        WHERE m.id IN (${placeholders})
    `).all<TrackMeta>(userId, ...trackIds);

    const byId = new Map(rows.map((r) => [r.id, r]));

    return events
        .map((event) => {
            const meta = byId.get(event.trackId);
            return meta ? { event, meta } : null;
        })
        .filter((x): x is { event: PlayEventInput, meta: TrackMeta } => x !== null);
}

/**
 * Filters out playlist ids the user has no access to, so a play can't be attributed to someone else's
 * playlist. A rejected playlist id nulls the field rather than dropping the event - the listen was still
 * real, only its stated context wasn't.
 */
async function filterPlaylistIds(userId: string, playlistIds: string[]): Promise<Set<string>> {
    if (playlistIds.length === 0) return new Set();

    const placeholders = playlistIds.map(() => "?").join(", ");
    const rows = await getLibrariesDb().prepare(`
        SELECT p.id
        FROM playlists p
        LEFT JOIN playlist_members pm ON pm.playlistId = p.id AND pm.userId = ?
        WHERE p.id IN (${placeholders})
          AND (p.ownerId = ? OR pm.id IS NOT NULL OR p.privacy = 'public')
    `).all<{ id: string }>(userId, ...playlistIds, userId);

    return new Set(rows.map((r) => r.id));
}

export interface IngestResult {
    accepted: number,
    /** events dropped because the track isn't in the user's library */
    unknownTracks: number
}

export async function insertPlayEvents(userId: string, events: PlayEventInput[]): Promise<IngestResult> {
    if (events.length === 0) return { accepted: 0, unknownTracks: 0 };

    const enriched = await enrichEvents(userId, events);
    const unknownTracks = events.length - enriched.length;
    if (enriched.length === 0) return { accepted: 0, unknownTracks };

    const requestedPlaylists = [...new Set(enriched.map((e) => e.event.playlistId).filter((id): id is string => id !== null))];
    const allowedPlaylists = await filterPlaylistIds(userId, requestedPlaylists);

    // one multi-row INSERT IGNORE rather than a statement per event: a flush is up to 50 rows, and IGNORE is
    // what makes a retried or double-flushed batch a no-op instead of a primary-key error
    // typed concretely rather than unknown[], which mysql2's execute() will not accept
    const values: (string | number | null)[] = [];
    const tuples: string[] = [];

    for (const { event, meta } of enriched) {
        tuples.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        values.push(
            event.eventId,
            userId,
            event.trackId,
            meta.albumId || UNKNOWN_ALBUM,
            meta.artistMbid || null,
            event.playlistId && allowedPlaylists.has(event.playlistId) ? event.playlistId : null,
            toMysqlDateTime(event.startedAtMs),
            event.durationMs,
            event.completed ? 1 : 0,
            event.source
        );
    }

    const result = await withTransaction(async (conn) => {
        const [res] = await conn.execute(`
            INSERT IGNORE INTO play_events
                (event_id, user_id, track_id, album_id, artist_id, playlist_id, started_at, duration_ms, completed, source)
            VALUES ${tuples.join(", ")}
        `, values);
        return res as { affectedRows?: number };
    });

    return { accepted: result.affectedRows ?? 0, unknownTracks };
}

// --- reads used by the rollup jobs and the export ---------------------------------------------------

export interface RawEventForRollup {
    event_id: string,
    track_id: string,
    album_id: string,
    artist_id: string | null,
    playlist_id: string | null,
    started_at: Date,
    duration_ms: number,
    completed: number,
    track_duration: number | null,
    title: string | null,
    artistName: string | null,
    album: string | null,
    coverArt: string | null
}

/**
 * Every event for one user in a half-open [fromMs, toMs) window, joined to whatever `media` still knows
 * about each track.
 *
 * The join is a LEFT JOIN on purpose: a track deleted from the library since it was played must still appear
 * in the history. `track_duration` then comes back NULL, which eventWeight() treats as "ratio unknown" and
 * falls back to the raw duration threshold.
 *
 * The window predicate converts the *constants*, never the column - `started_at >= FROM_UNIXTIME(...)` uses
 * idx_pe_user_time, whereas wrapping started_at in UNIX_TIMESTAMP() would force a full scan.
 */
export async function getEventsForWindow(userId: string, fromMs: number, toMs: number): Promise<RawEventForRollup[]> {
    return await getLibrariesDb().prepare(`
        SELECT pe.event_id, pe.track_id, pe.album_id, pe.artist_id, pe.playlist_id,
               pe.started_at, pe.duration_ms, pe.completed,
               m.duration AS track_duration, m.title, m.artistName, m.album, m.coverArt
        FROM play_events pe
        LEFT JOIN media m ON m.id = pe.track_id
        WHERE pe.user_id = :userId
          AND pe.started_at >= FROM_UNIXTIME(:fromMs / 1000)
          AND pe.started_at < FROM_UNIXTIME(:toMs / 1000)
        ORDER BY pe.started_at ASC
    `).all<RawEventForRollup>({ userId, fromMs, toMs });
}

/** distinct users with at least one event in the window - the work list for a rollup pass */
export async function getUsersWithEventsInWindow(fromMs: number, toMs: number): Promise<string[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT DISTINCT user_id
        FROM play_events
        WHERE started_at >= FROM_UNIXTIME(:fromMs / 1000)
          AND started_at < FROM_UNIXTIME(:toMs / 1000)
    `).all<{ user_id: string }>({ fromMs, toMs });
    return rows.map((r) => r.user_id);
}

export async function countEventsForUser(userId: string): Promise<number> {
    const row = await getLibrariesDb()
        .prepare(`SELECT COUNT(*) AS total FROM play_events WHERE user_id = ?`)
        .get<{ total: number | string }>(userId);
    // mysql2 hands COUNT()/SUM() back as a string; without the cast this silently becomes string arithmetic
    return Number(row?.total ?? 0);
}

/** paginated raw-event read, used only by the personal data export */
export async function getEventsForExport(userId: string, limit: number, offset: number): Promise<PlayEventRow[]> {
    return await getLibrariesDb().prepare(`
        SELECT * FROM play_events
        WHERE user_id = ?
        ORDER BY started_at ASC, event_id ASC
        LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}
    `).all<PlayEventRow>(userId);
}

// --- deletion ---------------------------------------------------------------------------------------

/**
 * Permanently erases every trace of a user's listening history: the raw events, all three aggregate levels,
 * their Replay Mixes and their year-end snapshots.
 *
 * Reel files on disk are removed separately by the caller (see the history DELETE route), because this
 * module deliberately knows nothing about the filesystem.
 */
export async function deleteUserHistory(userId: string): Promise<void> {
    await withTransaction(async (conn) => {
        for (const table of [
            "play_events",
            "user_entity_stats_daily",
            "user_hour_stats_daily",
            "user_entity_stats_monthly",
            "user_entity_stats_yearly",
            "user_replay_playlists",
            "user_year_snapshots"
        ]) {
            // table names are from this hard-coded list, never from a caller
            await conn.execute(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
        }
    });
}

/** retention sweep. A retentionDays of 0 means "keep forever" and is the shipped default. */
export async function pruneEventsOlderThan(retentionDays: number): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    // capped per pass so a first prune on a long-lived install can't lock the table for minutes at a time;
    // the job simply runs again tomorrow
    const result = await getLibrariesDb().prepare(`
        DELETE FROM play_events
        WHERE created_at < FROM_UNIXTIME(:cutoffMs / 1000)
        LIMIT ${sqlInt(50_000)}
    `).run({ cutoffMs });

    return result.changes;
}
