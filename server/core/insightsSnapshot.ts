// the year-end snapshot: a frozen copy of a user's yearly summary, taken at the start of December.
//
// Why freeze at all, when the aggregates are right there? Because the year-end package is something people
// look at and share, and it should keep saying the same thing forever. Aggregates carry live display data
// that shifts underneath them - a track leaves the library, an album's cover art changes, a playlist is
// renamed - and a "2026 in review" that quietly rewrites itself in 2029 is a worse product than one that
// preserves the moment.
import { getLibrariesDb } from "./db";
import {
    getBucketTotals, getTopEntitiesForBucket, getHourHistogram, getLongestStreak,
    getMultiYearComparison, type RankedEntity
} from "./insightsQuery";
import { yearBounds, type EntityType } from "~~/server/utils/insightsPeriod";

/** how many entries of each type the frozen package keeps */
const SNAPSHOT_TOP_N = 25;

export type ReelStatus = "none" | "queued" | "rendering" | "ready" | "failed";

export interface YearSnapshotPayload {
    year: number,
    generatedAt: number,
    totals: {
        totalMinutes: number,
        totalPlays: number,
        uniqueTracks: number,
        uniqueAlbums: number,
        uniqueArtists: number,
        uniquePlaylists: number,
        longestStreakDays: number
    },
    top: Record<EntityType, RankedEntity[]>,
    monthlyMinutes: number[],
    hourHistogram: { hour: number, plays: number, minutes: number }[],
    firstPlays: { entityType: EntityType, entityId: string, title: string | null, firstPlayedAt: number | null }[]
}

export interface YearSnapshot {
    userId: string,
    year: number,
    payload: YearSnapshotPayload,
    totalMinutes: number,
    uniqueTracks: number,
    uniqueAlbums: number,
    uniqueArtists: number,
    longestStreakDays: number,
    reelStatus: ReelStatus,
    hasReel: boolean,
    reelError: string | null,
    createdAt: number
}

interface SnapshotRow {
    user_id: string,
    bucket_year: number,
    payload: string | YearSnapshotPayload,
    total_minutes: number,
    unique_tracks: number,
    unique_albums: number,
    unique_artists: number,
    longest_streak_days: number,
    reel_status: ReelStatus,
    reel_path: string | null,
    reel_error: string | null,
    created_at: Date
}

function rowToSnapshot(row: SnapshotRow): YearSnapshot {
    return {
        userId: row.user_id,
        year: Number(row.bucket_year),
        // the mysql2 JSON type is decoded for us, but a driver/column change would hand back a string -
        // parsing defensively costs nothing and avoids a very confusing runtime shape mismatch
        payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
        totalMinutes: Number(row.total_minutes),
        uniqueTracks: Number(row.unique_tracks),
        uniqueAlbums: Number(row.unique_albums),
        uniqueArtists: Number(row.unique_artists),
        longestStreakDays: Number(row.longest_streak_days),
        reelStatus: row.reel_status,
        // the path itself is never exposed - clients get a status and an asset endpoint, not a filename
        hasReel: row.reel_status === "ready" && row.reel_path !== null,
        reelError: row.reel_error,
        createdAt: row.created_at.getTime()
    };
}

/** builds and stores the frozen package for one user and year. Idempotent - re-running overwrites. */
export async function snapshotYear(userId: string, year: number, tzOffsetMinutes: number): Promise<YearSnapshot> {
    const { startMs, endMs } = yearBounds(year, tzOffsetMinutes);

    const [totals, streak, hourHistogram, comparison] = await Promise.all([
        getBucketTotals(userId, "yearly", { year }),
        getLongestStreak(userId, startMs, endMs),
        getHourHistogram(userId, startMs, endMs),
        getMultiYearComparison(userId, [year])
    ]);

    const top = {} as Record<EntityType, RankedEntity[]>;
    for (const entityType of ["track", "album", "artist", "playlist"] as EntityType[]) {
        top[entityType] = await getTopEntitiesForBucket(userId, "yearly", { year }, entityType, SNAPSHOT_TOP_N, 0);
    }

    const payload: YearSnapshotPayload = {
        year,
        generatedAt: Date.now(),
        totals: { ...totals, longestStreakDays: streak },
        top,
        monthlyMinutes: comparison[0]?.monthlyMinutes ?? Array(12).fill(0),
        hourHistogram,
        // "first-play dates for key entities": the year's top artists and albums, dated by when the user
        // first heard them
        firstPlays: [...top.artist.slice(0, 10), ...top.album.slice(0, 10)].map((e) => ({
            entityType: e.entityType,
            entityId: e.entityId,
            title: e.title,
            firstPlayedAt: e.firstPlayedAt
        }))
    };

    await getLibrariesDb().prepare(`
        INSERT INTO user_year_snapshots
            (user_id, bucket_year, payload, total_minutes, unique_tracks, unique_albums, unique_artists, longest_streak_days)
        VALUES (:userId, :year, :payload, :minutes, :tracks, :albums, :artists, :streak)
        ON DUPLICATE KEY UPDATE
            payload = VALUES(payload),
            total_minutes = VALUES(total_minutes),
            unique_tracks = VALUES(unique_tracks),
            unique_albums = VALUES(unique_albums),
            unique_artists = VALUES(unique_artists),
            longest_streak_days = VALUES(longest_streak_days)
            -- reel_status/reel_path deliberately untouched: re-snapshotting a year must not throw away an
            -- MP4 the user already waited for
    `).run({
        userId,
        year,
        payload: JSON.stringify(payload),
        minutes: totals.totalMinutes,
        tracks: totals.uniqueTracks,
        albums: totals.uniqueAlbums,
        artists: totals.uniqueArtists,
        streak
    });

    return (await getYearSnapshot(userId, year))!;
}

export async function getYearSnapshot(userId: string, year: number): Promise<YearSnapshot | null> {
    const row = await getLibrariesDb()
        .prepare(`SELECT * FROM user_year_snapshots WHERE user_id = ? AND bucket_year = ?`)
        .get<SnapshotRow>(userId, year);
    return row ? rowToSnapshot(row) : null;
}

export async function listYearSnapshots(userId: string): Promise<YearSnapshot[]> {
    const rows = await getLibrariesDb()
        .prepare(`SELECT * FROM user_year_snapshots WHERE user_id = ? ORDER BY bucket_year DESC`)
        .all<SnapshotRow>(userId);
    return rows.map(rowToSnapshot);
}
