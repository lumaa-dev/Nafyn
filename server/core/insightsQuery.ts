// read side for listening insights.
//
// Everything here reads the aggregate tables, never play_events. That is a privacy commitment as much as a
// performance one: raw events are the private record, aggregates are what the product is built on, and
// keeping the boundary strict is what makes a future retention policy possible without breaking any screen.
//
// Two shapes of query live here. Month and year surfaces read a precomputed bucket, where `rank_in_bucket`
// is already sitting in an index. Week surfaces have no bucket table of their own (a week straddles months,
// and materializing one would double the write cost for a seven-row window), so they sum the daily rows and
// score in JS - seven days per user is trivial.
import { getLibrariesDb, sqlInt } from "./db";
import { getInsightsConfig } from "./insightsConfig";
import { scoreEntities, type ScorableRow } from "./insightsScore";
import { toMysqlDate, type EntityType, DAY_MS } from "~~/server/utils/insightsPeriod";

export interface RankedEntity {
    entityType: EntityType,
    entityId: string,
    rank: number,
    score: number,
    playCount: number,
    totalDurationMs: number,
    minutes: number,
    firstPlayedAt: number | null,
    lastPlayedAt: number | null,
    isFirstEver: boolean,
    title: string | null,
    subtitle: string | null,
    cover: string | null
}

export interface PeriodTotals {
    totalMinutes: number,
    totalPlays: number,
    uniqueTracks: number,
    uniqueAlbums: number,
    uniqueArtists: number,
    uniquePlaylists: number,
    longestStreakDays: number
}

interface StatsRow {
    entity_type: EntityType,
    entity_id: string,
    play_count: number | string,
    weighted_play_count: number | string,
    total_duration_ms: number | string,
    first_played_at: Date | null,
    last_played_at: Date | null,
    is_first_ever: number,
    score?: number | string,
    rank_in_bucket?: number | string,
    display_title: string | null,
    display_subtitle: string | null,
    display_cover: string | null
}

// mysql2 returns SUM()/COUNT() and DECIMAL columns as strings. Every numeric read in this file goes through
// here; skipping it turns `a + b` into string concatenation and comparisons into lexicographic ones, which
// produces confidently wrong numbers rather than an error.
function num(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function toRanked(row: StatsRow, rank: number, score: number): RankedEntity {
    const totalDurationMs = num(row.total_duration_ms);
    return {
        entityType: row.entity_type,
        entityId: row.entity_id,
        rank,
        score,
        playCount: num(row.play_count),
        totalDurationMs,
        minutes: Math.round(totalDurationMs / 60_000),
        firstPlayedAt: row.first_played_at ? row.first_played_at.getTime() : null,
        lastPlayedAt: row.last_played_at ? row.last_played_at.getTime() : null,
        isFirstEver: row.is_first_ever === 1,
        title: row.display_title,
        subtitle: row.display_subtitle,
        cover: row.display_cover
    };
}

// --- bucket reads (month / year) ---------------------------------------------------------------------

// hard-coded table names and predicates, selected by a typed key. Nothing a caller sends ever becomes SQL.
const BUCKETS = {
    monthly: { table: "user_entity_stats_monthly", predicate: "bucket_year = :year AND bucket_month = :month" },
    yearly: { table: "user_entity_stats_yearly", predicate: "bucket_year = :year" }
} as const;

export type BucketLevel = keyof typeof BUCKETS;
export interface BucketKey { year: number, month?: number }

export async function getTopEntitiesForBucket(
    userId: string,
    level: BucketLevel,
    bucket: BucketKey,
    entityType: EntityType,
    limit: number,
    offset: number
): Promise<RankedEntity[]> {
    const spec = BUCKETS[level];
    const rows = await getLibrariesDb().prepare(`
        SELECT * FROM ${spec.table}
        WHERE user_id = :userId AND ${spec.predicate} AND entity_type = :entityType
        ORDER BY rank_in_bucket ASC
        LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}
    `).all<StatsRow>({ userId, year: bucket.year, month: bucket.month ?? 0, entityType });

    return rows.map((row) => toRanked(row, num(row.rank_in_bucket), num(row.score)));
}

export async function countEntitiesForBucket(userId: string, level: BucketLevel, bucket: BucketKey, entityType: EntityType): Promise<number> {
    const spec = BUCKETS[level];
    const row = await getLibrariesDb().prepare(`
        SELECT COUNT(*) AS total FROM ${spec.table}
        WHERE user_id = :userId AND ${spec.predicate} AND entity_type = :entityType
    `).get<{ total: number | string }>({ userId, year: bucket.year, month: bucket.month ?? 0, entityType });
    return num(row?.total);
}

export async function getBucketTotals(userId: string, level: BucketLevel, bucket: BucketKey): Promise<Omit<PeriodTotals, "longestStreakDays">> {
    const spec = BUCKETS[level];
    const params = { userId, year: bucket.year, month: bucket.month ?? 0 };

    // total listening time comes from the track rows alone. Album, artist and playlist rows are roll-ups of
    // the same seconds, so summing everything would report three or four times the real figure.
    const totals = await getLibrariesDb().prepare(`
        SELECT COALESCE(SUM(total_duration_ms), 0) AS duration, COALESCE(SUM(play_count), 0) AS plays
        FROM ${spec.table}
        WHERE user_id = :userId AND ${spec.predicate} AND entity_type = 'track'
    `).get<{ duration: string | number, plays: string | number }>(params);

    const uniques = await getLibrariesDb().prepare(`
        SELECT entity_type, COUNT(*) AS total
        FROM ${spec.table}
        WHERE user_id = :userId AND ${spec.predicate}
        GROUP BY entity_type
    `).all<{ entity_type: EntityType, total: string | number }>(params);

    const byType = new Map(uniques.map((u) => [u.entity_type, num(u.total)]));

    return {
        totalMinutes: Math.round(num(totals?.duration) / 60_000),
        totalPlays: num(totals?.plays),
        uniqueTracks: byType.get("track") ?? 0,
        uniqueAlbums: byType.get("album") ?? 0,
        uniqueArtists: byType.get("artist") ?? 0,
        uniquePlaylists: byType.get("playlist") ?? 0
    };
}

// --- range reads (week, or any arbitrary window) -----------------------------------------------------

export async function getTopEntitiesForRange(
    userId: string,
    entityType: EntityType,
    fromMs: number,
    toMs: number,
    limit: number,
    offset: number = 0
): Promise<RankedEntity[]> {
    const config = await getInsightsConfig();

    const rows = await getLibrariesDb().prepare(`
        SELECT entity_type, entity_id,
               SUM(play_count) AS play_count,
               SUM(weighted_play_count) AS weighted_play_count,
               SUM(total_duration_ms) AS total_duration_ms,
               MIN(first_played_at) AS first_played_at,
               MAX(last_played_at) AS last_played_at,
               MAX(is_first_ever) AS is_first_ever,
               MAX(display_title) AS display_title,
               MAX(display_subtitle) AS display_subtitle,
               MAX(display_cover) AS display_cover
        FROM user_entity_stats_daily
        WHERE user_id = :userId AND entity_type = :entityType
          AND bucket_date >= :from AND bucket_date < :to
        GROUP BY entity_type, entity_id
    `).all<StatsRow>({ userId, entityType, from: toMysqlDate(fromMs), to: toMysqlDate(toMs) });

    if (rows.length === 0) return [];

    const scorable: ScorableRow[] = rows.map((r) => ({
        entityId: r.entity_id,
        weightedPlayCount: num(r.weighted_play_count),
        totalDurationMs: num(r.total_duration_ms),
        lastPlayedAtMs: r.last_played_at ? r.last_played_at.getTime() : null
    }));

    const scored = scoreEntities(scorable, toMs, config);
    const byId = new Map(rows.map((r) => [r.entity_id, r]));

    return scored
        .slice(offset, offset + limit)
        .map((s) => toRanked(byId.get(s.entityId)!, s.rank, s.score));
}

export async function getRangeTotals(userId: string, fromMs: number, toMs: number): Promise<PeriodTotals> {
    const params = { userId, from: toMysqlDate(fromMs), to: toMysqlDate(toMs) };

    const totals = await getLibrariesDb().prepare(`
        SELECT COALESCE(SUM(total_duration_ms), 0) AS duration, COALESCE(SUM(play_count), 0) AS plays
        FROM user_entity_stats_daily
        WHERE user_id = :userId AND entity_type = 'track' AND bucket_date >= :from AND bucket_date < :to
    `).get<{ duration: string | number, plays: string | number }>(params);

    const uniques = await getLibrariesDb().prepare(`
        SELECT entity_type, COUNT(DISTINCT entity_id) AS total
        FROM user_entity_stats_daily
        WHERE user_id = :userId AND bucket_date >= :from AND bucket_date < :to
        GROUP BY entity_type
    `).all<{ entity_type: EntityType, total: string | number }>(params);

    const byType = new Map(uniques.map((u) => [u.entity_type, num(u.total)]));

    return {
        totalMinutes: Math.round(num(totals?.duration) / 60_000),
        totalPlays: num(totals?.plays),
        uniqueTracks: byType.get("track") ?? 0,
        uniqueAlbums: byType.get("album") ?? 0,
        uniqueArtists: byType.get("artist") ?? 0,
        uniquePlaylists: byType.get("playlist") ?? 0,
        longestStreakDays: await getLongestStreak(userId, fromMs, toMs)
    };
}

// --- series, histograms, streaks ---------------------------------------------------------------------

export interface DayPoint {
    date: string,
    minutes: number,
    plays: number
}

/** per-day minutes and plays across a window; the shape both the weekly overlay and the yearly sparkline want */
export async function getDailySeries(userId: string, fromMs: number, toMs: number): Promise<DayPoint[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT bucket_date, COALESCE(SUM(total_duration_ms), 0) AS duration, COALESCE(SUM(play_count), 0) AS plays
        FROM user_entity_stats_daily
        WHERE user_id = :userId AND entity_type = 'track' AND bucket_date >= :from AND bucket_date < :to
        GROUP BY bucket_date
        ORDER BY bucket_date ASC
    `).all<{ bucket_date: Date | string, duration: string | number, plays: string | number }>({
        userId, from: toMysqlDate(fromMs), to: toMysqlDate(toMs)
    });

    const byDate = new Map(rows.map((r) => [
        typeof r.bucket_date === "string" ? r.bucket_date : toMysqlDate(r.bucket_date.getTime()),
        { minutes: Math.round(num(r.duration) / 60_000), plays: num(r.plays) }
    ]));

    // days with no listening are filled in as zeroes rather than omitted, so a line chart draws a real gap
    // instead of joining across it and implying continuous playback
    const points: DayPoint[] = [];
    for (let ms = fromMs; ms < toMs; ms += DAY_MS) {
        const date = toMysqlDate(ms);
        const found = byDate.get(date);
        points.push({ date, minutes: found?.minutes ?? 0, plays: found?.plays ?? 0 });
    }
    return points;
}

export interface HourPoint {
    hour: number,
    plays: number,
    minutes: number
}

export async function getHourHistogram(userId: string, fromMs: number, toMs: number): Promise<HourPoint[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT hour, COALESCE(SUM(play_count), 0) AS plays, COALESCE(SUM(total_duration_ms), 0) AS duration
        FROM user_hour_stats_daily
        WHERE user_id = :userId AND bucket_date >= :from AND bucket_date < :to
        GROUP BY hour
    `).all<{ hour: number, plays: string | number, duration: string | number }>({
        userId, from: toMysqlDate(fromMs), to: toMysqlDate(toMs)
    });

    const byHour = new Map(rows.map((r) => [Number(r.hour), r]));

    // always 24 points, so the chart's x-axis is the clock rather than "whichever hours had data"
    return Array.from({ length: 24 }, (_, hour) => {
        const row = byHour.get(hour);
        return {
            hour,
            plays: num(row?.plays),
            minutes: Math.round(num(row?.duration) / 60_000)
        };
    });
}

/** longest run of consecutive local days with at least one play, within the window */
export async function getLongestStreak(userId: string, fromMs: number, toMs: number): Promise<number> {
    const rows = await getLibrariesDb().prepare(`
        SELECT DISTINCT bucket_date
        FROM user_entity_stats_daily
        WHERE user_id = :userId AND bucket_date >= :from AND bucket_date < :to
        ORDER BY bucket_date ASC
    `).all<{ bucket_date: Date | string }>({ userId, from: toMysqlDate(fromMs), to: toMysqlDate(toMs) });

    let longest = 0;
    let current = 0;
    let previousMs: number | null = null;

    for (const row of rows) {
        const dateKey = typeof row.bucket_date === "string" ? row.bucket_date : toMysqlDate(row.bucket_date.getTime());
        const ms = Date.parse(`${dateKey}T00:00:00.000Z`);

        // consecutive is measured in whole UTC days between two date *keys*, which sidesteps DST entirely -
        // the keys are already local calendar dates, so there is no 23- or 25-hour day to trip over
        current = previousMs !== null && ms - previousMs === DAY_MS ? current + 1 : 1;
        if (current > longest) longest = current;
        previousMs = ms;
    }

    return longest;
}

// --- gate, comparisons, all-time ---------------------------------------------------------------------

/**
 * The "enough data" gate. A ranking built from four plays says nothing interesting and reads as broken, so
 * every ranking surface stays hidden until the user clears one of the two thresholds.
 */
export async function hasEnoughData(userId: string, fromMs: number, toMs: number): Promise<{ enough: boolean, uniqueTracks: number, minutes: number, needUniqueTracks: number, needMinutes: number }> {
    const config = await getInsightsConfig();

    const row = await getLibrariesDb().prepare(`
        SELECT COUNT(DISTINCT entity_id) AS tracks, COALESCE(SUM(total_duration_ms), 0) AS duration
        FROM user_entity_stats_daily
        WHERE user_id = :userId AND entity_type = 'track' AND bucket_date >= :from AND bucket_date < :to
    `).get<{ tracks: string | number, duration: string | number }>({
        userId, from: toMysqlDate(fromMs), to: toMysqlDate(toMs)
    });

    const uniqueTracks = num(row?.tracks);
    const minutes = Math.round(num(row?.duration) / 60_000);

    return {
        enough: uniqueTracks >= config.gateMinUniqueTracks || minutes >= config.gateMinMinutes,
        uniqueTracks,
        minutes,
        needUniqueTracks: config.gateMinUniqueTracks,
        needMinutes: config.gateMinMinutes
    };
}

export interface YearComparison {
    year: number,
    totalMinutes: number,
    totalPlays: number,
    uniqueTracks: number,
    uniqueAlbums: number,
    uniqueArtists: number,
    monthlyMinutes: number[]
}

export async function getMultiYearComparison(userId: string, years: number[]): Promise<YearComparison[]> {
    const out: YearComparison[] = [];

    for (const year of years) {
        const totals = await getBucketTotals(userId, "yearly", { year });

        const months = await getLibrariesDb().prepare(`
            SELECT bucket_month, COALESCE(SUM(total_duration_ms), 0) AS duration
            FROM user_entity_stats_monthly
            WHERE user_id = :userId AND bucket_year = :year AND entity_type = 'track'
            GROUP BY bucket_month
        `).all<{ bucket_month: number, duration: string | number }>({ userId, year });

        const byMonth = new Map(months.map((m) => [Number(m.bucket_month), Math.round(num(m.duration) / 60_000)]));

        out.push({
            year,
            totalMinutes: totals.totalMinutes,
            totalPlays: totals.totalPlays,
            uniqueTracks: totals.uniqueTracks,
            uniqueAlbums: totals.uniqueAlbums,
            uniqueArtists: totals.uniqueArtists,
            // always 12 entries so two years line up index-for-index on an overlaid chart
            monthlyMinutes: Array.from({ length: 12 }, (_, i) => byMonth.get(i + 1) ?? 0)
        });
    }

    return out;
}

/** years the user has any yearly aggregate for, newest first - drives the year switcher */
export async function getYearsWithData(userId: string): Promise<number[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT DISTINCT bucket_year FROM user_entity_stats_yearly
        WHERE user_id = ? ORDER BY bucket_year DESC
    `).all<{ bucket_year: number }>(userId);
    return rows.map((r) => Number(r.bucket_year));
}

/** all-time ranking, summed across every year the user has data for */
export async function getAllTimeTop(userId: string, entityType: EntityType, limit: number, offset: number = 0): Promise<RankedEntity[]> {
    const config = await getInsightsConfig();

    const rows = await getLibrariesDb().prepare(`
        SELECT entity_type, entity_id,
               SUM(play_count) AS play_count,
               SUM(weighted_play_count) AS weighted_play_count,
               SUM(total_duration_ms) AS total_duration_ms,
               MIN(first_played_at) AS first_played_at,
               MAX(last_played_at) AS last_played_at,
               MAX(is_first_ever) AS is_first_ever,
               MAX(display_title) AS display_title,
               MAX(display_subtitle) AS display_subtitle,
               MAX(display_cover) AS display_cover
        FROM user_entity_stats_yearly
        WHERE user_id = :userId AND entity_type = :entityType
        GROUP BY entity_type, entity_id
    `).all<StatsRow>({ userId, entityType });

    if (rows.length === 0) return [];

    const scored = scoreEntities(rows.map((r) => ({
        entityId: r.entity_id,
        weightedPlayCount: num(r.weighted_play_count),
        totalDurationMs: num(r.total_duration_ms),
        lastPlayedAtMs: r.last_played_at ? r.last_played_at.getTime() : null
    })), Date.now(), config);

    const byId = new Map(rows.map((r) => [r.entity_id, r]));
    return scored.slice(offset, offset + limit).map((s) => toRanked(byId.get(s.entityId)!, s.rank, s.score));
}

export async function countAllTime(userId: string, entityType: EntityType): Promise<number> {
    const row = await getLibrariesDb().prepare(`
        SELECT COUNT(DISTINCT entity_id) AS total FROM user_entity_stats_yearly
        WHERE user_id = ? AND entity_type = ?
    `).get<{ total: string | number }>(userId, entityType);
    return num(row?.total);
}
