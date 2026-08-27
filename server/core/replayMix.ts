// the Replay Mix: a per-user, top-100 playlist for a calendar year, rebuilt weekly, plus an All-Time mix.
//
// IMMUTABILITY. The mix is required to be unmodifiable by the user and by admins, through the UI and through
// the API. It achieves that by construction rather than by policy: a Replay Mix is not a row in `playlists`,
// so there is simply no playlist id for PATCH/DELETE /playlist/{pid}, /tracks, /order, /members, /image or
// /leave to resolve. Every one of those routes already 404s on an unknown id, with no new guard to write and
// none for a future route to forget.
//
// The virtual ids below ("replay-2026", "replay-all-time") exist only so the Subsonic layer can expose the
// mix read-only to third-party clients. assertNotReplayPlaylist() is defence in depth for the day somebody
// decides to mirror the mix into `playlists` for convenience.
import { getLibrariesDb, withTransaction, sqlInt } from "./db";
import { getInsightsConfig } from "./insightsConfig";
import type { MediaRow } from "./library";

export const REPLAY_ID_PREFIX = "replay-";
/** bucket_year 0 is reserved for the All-Time mix */
export const ALL_TIME_YEAR = 0;

export function replayPlaylistId(year: number): string {
    return year === ALL_TIME_YEAR ? `${REPLAY_ID_PREFIX}all-time` : `${REPLAY_ID_PREFIX}${year}`;
}

export function isReplayPlaylistId(value: unknown): value is string {
    return typeof value === "string" && /^replay-(all-time|\d{4})$/.test(value);
}

/** "replay-2026" -> 2026, "replay-all-time" -> 0, anything else -> null */
export function parseReplayPlaylistId(value: unknown): number | null {
    if (!isReplayPlaylistId(value)) return null;
    const suffix = value.slice(REPLAY_ID_PREFIX.length);
    return suffix === "all-time" ? ALL_TIME_YEAR : Number(suffix);
}

/**
 * Defence in depth for the playlist mutators. Today no Replay Mix id can reach them (there is no such row in
 * `playlists`), but if the mix is ever mirrored into that table this is the one place that has to know, and
 * it sits in core so it covers the REST routes and the Subsonic layer at once.
 */
export function assertNotReplayPlaylist(id: unknown): void {
    if (isReplayPlaylistId(id)) {
        throw createError({ statusCode: 403, statusMessage: "The Replay Mix can't be modified" });
    }
}

export interface ReplayEntry {
    position: number,
    trackId: string,
    score: number,
    playCount: number,
    totalDurationMs: number,
    minutes: number,
    title: string | null,
    subtitle: string | null,
    cover: string | null,
    /** the track is still in the user's library and can be played; false means history-only */
    available: boolean,
    media: MediaRow | null
}

export interface ReplayMix {
    id: string,
    year: number,
    isAllTime: boolean,
    refreshedAt: number | null,
    entries: ReplayEntry[]
}

/**
 * Rebuilds one year's mix from the yearly aggregates.
 *
 * Restricted to tracks the user still holds a library entry for: a mix is something you press play on, and
 * padding it with rows that 404 on stream would be worse than a shorter list. History for removed tracks is
 * untouched and still surfaces in the ranked lists.
 */
export async function rebuildReplayMix(userId: string, year: number): Promise<number> {
    const config = await getInsightsConfig();

    const rows = await getLibrariesDb().prepare(`
        SELECT y.entity_id, y.score, y.play_count, y.total_duration_ms,
               y.display_title, y.display_subtitle, y.display_cover
        FROM user_entity_stats_yearly y
        JOIN library_entries le ON le.mediaId = y.entity_id AND le.userId = y.user_id
        WHERE y.user_id = :userId AND y.bucket_year = :year AND y.entity_type = 'track'
        ORDER BY y.rank_in_bucket ASC
        LIMIT ${sqlInt(config.replayMixSize)}
    `).all<{
        entity_id: string, score: number | string, play_count: number | string, total_duration_ms: number | string,
        display_title: string | null, display_subtitle: string | null, display_cover: string | null
    }>({ userId, year });

    await writeMix(userId, year, rows);
    return rows.length;
}

/** the All-Time mix: the same ranking, summed across every year, stored at bucket_year 0 */
export async function rebuildAllTime(userId: string): Promise<number> {
    const config = await getInsightsConfig();

    // ranked by lifetime listening time then play count rather than by `score`, because scores are
    // normalized within their own year and are not comparable across years - summing them would quietly
    // favour whichever year the user listened least in
    const rows = await getLibrariesDb().prepare(`
        SELECT y.entity_id,
               SUM(y.total_duration_ms) AS total_duration_ms,
               SUM(y.play_count) AS play_count,
               0 AS score,
               MAX(y.display_title) AS display_title,
               MAX(y.display_subtitle) AS display_subtitle,
               MAX(y.display_cover) AS display_cover
        FROM user_entity_stats_yearly y
        JOIN library_entries le ON le.mediaId = y.entity_id AND le.userId = y.user_id
        WHERE y.user_id = :userId AND y.entity_type = 'track'
        GROUP BY y.entity_id
        ORDER BY SUM(y.total_duration_ms) DESC, SUM(y.play_count) DESC, y.entity_id ASC
        LIMIT ${sqlInt(config.replayMixSize)}
    `).all<{
        entity_id: string, score: number | string, play_count: number | string, total_duration_ms: number | string,
        display_title: string | null, display_subtitle: string | null, display_cover: string | null
    }>({ userId });

    await writeMix(userId, ALL_TIME_YEAR, rows);
    return rows.length;
}

async function writeMix(
    userId: string,
    year: number,
    rows: { entity_id: string, score: number | string, play_count: number | string, total_duration_ms: number | string, display_title: string | null, display_subtitle: string | null, display_cover: string | null }[]
): Promise<void> {
    await withTransaction(async (conn) => {
        // delete-then-insert rather than upsert: the new mix is usually shorter or longer than the old one,
        // and an upsert would leave the tail of a longer previous mix stranded at the end
        await conn.execute(`DELETE FROM user_replay_playlists WHERE user_id = ? AND bucket_year = ?`, [userId, year]);

        if (rows.length === 0) return;

        const tuples: string[] = [];
        // typed concretely rather than unknown[], which mysql2's execute() will not accept
        const values: (string | number | null)[] = [];

        rows.forEach((row, index) => {
            tuples.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            values.push(
                userId,
                year,
                index,
                row.entity_id,
                // mysql2 gives DECIMAL/BIGINT aggregates back as strings
                Number(row.score) || 0,
                Number(row.play_count) || 0,
                Number(row.total_duration_ms) || 0,
                row.display_title?.slice(0, 255) ?? null,
                row.display_subtitle?.slice(0, 255) ?? null,
                row.display_cover ?? null
            );
        });

        await conn.execute(`
            INSERT INTO user_replay_playlists
                (user_id, bucket_year, position, track_id, score, play_count, total_duration_ms,
                 display_title, display_subtitle, display_cover)
            VALUES ${tuples.join(", ")}
        `, values);
    });
}

interface MixRow {
    position: number,
    track_id: string,
    score: number | string,
    play_count: number | string,
    total_duration_ms: number | string,
    display_title: string | null,
    display_subtitle: string | null,
    display_cover: string | null,
    refreshed_at: Date
}

export async function getReplayMix(userId: string, year: number): Promise<ReplayMix> {
    const rows = await getLibrariesDb().prepare(`
        SELECT * FROM user_replay_playlists
        WHERE user_id = :userId AND bucket_year = :year
        ORDER BY position ASC
    `).all<MixRow>({ userId, year });

    const mix: ReplayMix = {
        id: replayPlaylistId(year),
        year,
        isAllTime: year === ALL_TIME_YEAR,
        refreshedAt: rows[0]?.refreshed_at ? rows[0].refreshed_at.getTime() : null,
        entries: []
    };

    if (rows.length === 0) return mix;

    // media is fetched separately (rather than joined above) so the mix still renders, marked unavailable,
    // for a track the user removed from their library since the last weekly rebuild
    const placeholders = rows.map(() => "?").join(", ");
    const media = await getLibrariesDb().prepare(`
        SELECT m.* FROM media m
        JOIN library_entries le ON le.mediaId = m.id AND le.userId = ?
        WHERE m.id IN (${placeholders})
    `).all<MediaRow>(userId, ...rows.map((r) => r.track_id));

    const byId = new Map(media.map((m) => [m.id, m]));

    mix.entries = rows.map((row) => {
        const found = byId.get(row.track_id) ?? null;
        const totalDurationMs = Number(row.total_duration_ms) || 0;
        return {
            position: Number(row.position),
            trackId: row.track_id,
            score: Number(row.score) || 0,
            playCount: Number(row.play_count) || 0,
            totalDurationMs,
            minutes: Math.round(totalDurationMs / 60_000),
            title: found?.title ?? row.display_title,
            subtitle: found?.artistName ?? row.display_subtitle,
            cover: found?.coverArt ?? row.display_cover,
            available: found !== null,
            media: found
        };
    });

    return mix;
}

/** every year (plus All-Time) the user has a stored mix for, newest first - the archive listing */
export async function listReplayYears(userId: string): Promise<{ year: number, id: string, trackCount: number, refreshedAt: number | null }[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT bucket_year, COUNT(*) AS total, MAX(refreshed_at) AS refreshed
        FROM user_replay_playlists
        WHERE user_id = ?
        GROUP BY bucket_year
        ORDER BY bucket_year DESC
    `).all<{ bucket_year: number, total: string | number, refreshed: Date | null }>(userId);

    return rows.map((r) => ({
        year: Number(r.bucket_year),
        id: replayPlaylistId(Number(r.bucket_year)),
        trackCount: Number(r.total) || 0,
        refreshedAt: r.refreshed ? r.refreshed.getTime() : null
    }));
}
