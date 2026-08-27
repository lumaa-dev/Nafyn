// rolls raw play events up into the daily/monthly/yearly aggregate tables and scores them.
//
// Division of labour: SQL groups and sums, JavaScript normalizes, decays, scores and ranks. Normalization
// needs the maximum across the whole window (awkward to express in MySQL without a second pass anyway) and
// the decay is exponential, while the row counts involved are thousands per user per year at most - so the
// scoring half is far clearer, and no slower, in JS.
//
// Every one of these functions is idempotent. A rollup recomputes its bucket from scratch and overwrites,
// rather than adding to what's there, so re-running a day (after a late offline flush, say, or a crashed
// job) converges on the right answer instead of double-counting.
import { getLibrariesDb, withTransaction } from "./db";
import { getEventsForWindow, type RawEventForRollup } from "./playEvents";
import { getInsightsConfig, type InsightsConfig } from "./insightsConfig";
import { eventWeight, scoreEntities, type ScorableRow } from "./insightsScore";
import {
    dateKeyToBounds, localDateKey, localParts, monthBounds, yearBounds, toMysqlDate,
    type EntityType
} from "~~/server/utils/insightsPeriod";

const UNKNOWN_ALBUM = "unknown-album";

interface Accumulator {
    entityType: EntityType,
    entityId: string,
    playCount: number,
    weightedPlayCount: number,
    totalDurationMs: number,
    firstPlayedAtMs: number,
    lastPlayedAtMs: number,
    displayTitle: string | null,
    displaySubtitle: string | null,
    displayCover: string | null
}

function key(type: EntityType, id: string): string {
    return `${type}${id}`;
}

/** the display fields shown for each entity type when the underlying media row is long gone */
function displayFor(type: EntityType, event: RawEventForRollup): { title: string | null, subtitle: string | null, cover: string | null } {
    switch (type) {
        case "track":
            return { title: event.title, subtitle: event.artistName, cover: event.coverArt };
        case "album":
            return { title: event.album, subtitle: event.artistName, cover: event.coverArt };
        case "artist":
            return { title: event.artistName, subtitle: null, cover: null };
        case "playlist":
            // playlists are named in their own table and can be renamed, so the daily row deliberately
            // carries no snapshot - the read side joins `playlists` for a live title
            return { title: null, subtitle: null, cover: null };
    }
}

/** every (entity type, entity id) one event contributes to */
function entitiesOf(event: RawEventForRollup): { type: EntityType, id: string }[] {
    const out: { type: EntityType, id: string }[] = [{ type: "track", id: event.track_id }];

    // the sentinel means "no release group was ever resolved" - ranking it would produce a phantom album
    // made of every unmatched track the user owns
    if (event.album_id && event.album_id !== UNKNOWN_ALBUM) out.push({ type: "album", id: event.album_id });
    if (event.artist_id) out.push({ type: "artist", id: event.artist_id });
    if (event.playlist_id) out.push({ type: "playlist", id: event.playlist_id });

    return out;
}

function accumulate(events: RawEventForRollup[], config: InsightsConfig): Map<string, Accumulator> {
    const acc = new Map<string, Accumulator>();

    for (const event of events) {
        const startedAtMs = event.started_at.getTime();
        const durationMs = Number(event.duration_ms) || 0;

        const weight = eventWeight({
            durationMs,
            completed: event.completed === 1,
            // media.duration is seconds; a deleted media row leaves it NULL, which eventWeight reads as
            // "unknown length" and falls back to the raw 30s threshold
            trackDurationMs: event.track_duration === null ? 0 : Number(event.track_duration) * 1000
        }, config);

        for (const { type, id } of entitiesOf(event)) {
            const k = key(type, id);
            let entry = acc.get(k);

            if (!entry) {
                const display = displayFor(type, event);
                entry = {
                    entityType: type,
                    entityId: id,
                    playCount: 0,
                    weightedPlayCount: 0,
                    totalDurationMs: 0,
                    firstPlayedAtMs: startedAtMs,
                    lastPlayedAtMs: startedAtMs,
                    displayTitle: display.title,
                    displaySubtitle: display.subtitle,
                    displayCover: display.cover
                };
                acc.set(k, entry);
            }

            // a zero-weight play is one that didn't clear the 30s bar: it counts as no play at all, but the
            // seconds the user did spend listening are real and still count toward their total minutes
            if (weight > 0) entry.playCount += 1;
            entry.weightedPlayCount += weight;
            entry.totalDurationMs += durationMs;

            if (startedAtMs < entry.firstPlayedAtMs) entry.firstPlayedAtMs = startedAtMs;
            if (startedAtMs > entry.lastPlayedAtMs) entry.lastPlayedAtMs = startedAtMs;
        }
    }

    return acc;
}

/**
 * Which of these entities the user had never played before this day.
 *
 * Powers the "first-play dates" surface, and is computed against the daily table rather than play_events so
 * it stays correct after a retention prune.
 */
async function findFirstEver(userId: string, dateKey: string, entries: Accumulator[]): Promise<Set<string>> {
    if (entries.length === 0) return new Set();

    const placeholders = entries.map(() => "(?, ?)").join(", ");
    const params: unknown[] = [userId, dateKey];
    for (const e of entries) params.push(e.entityType, e.entityId);

    const rows = await getLibrariesDb().prepare(`
        SELECT DISTINCT entity_type, entity_id
        FROM user_entity_stats_daily
        WHERE user_id = ? AND bucket_date < ? AND (entity_type, entity_id) IN (${placeholders})
    `).all<{ entity_type: EntityType, entity_id: string }>(...params);

    const seenBefore = new Set(rows.map((r) => key(r.entity_type, r.entity_id)));
    return new Set(entries.filter((e) => !seenBefore.has(key(e.entityType, e.entityId))).map((e) => key(e.entityType, e.entityId)));
}

/** recomputes one local calendar day for one user from the raw events */
export async function rollupDay(userId: string, dateKey: string, tzOffsetMinutes: number): Promise<number> {
    const config = await getInsightsConfig();
    const { startMs, endMs } = dateKeyToBounds(dateKey, tzOffsetMinutes);

    const events = await getEventsForWindow(userId, startMs, endMs);
    if (events.length === 0) return 0;

    const entries = [...accumulate(events, config).values()];
    const firstEver = await findFirstEver(userId, dateKey, entries);

    const tuples: string[] = [];
    // typed concretely rather than unknown[], which mysql2's execute() will not accept
    const values: (string | number | null)[] = [];

    for (const entry of entries) {
        tuples.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        values.push(
            userId,
            dateKey,
            entry.entityType,
            entry.entityId,
            entry.playCount,
            entry.weightedPlayCount.toFixed(3),
            entry.totalDurationMs,
            new Date(entry.firstPlayedAtMs).toISOString().slice(0, 23).replace("T", " "),
            new Date(entry.lastPlayedAtMs).toISOString().slice(0, 23).replace("T", " "),
            firstEver.has(key(entry.entityType, entry.entityId)) ? 1 : 0,
            entry.displayTitle?.slice(0, 255) ?? null,
            entry.displaySubtitle?.slice(0, 255) ?? null,
            entry.displayCover ?? null
        );
    }

    // VALUES(...) on every column, not `col = col + VALUES(col)`: this recomputes the whole day, so it must
    // overwrite rather than accumulate or a re-run would double the day's numbers
    await withTransaction(async (conn) => {
        await conn.execute(`
            INSERT INTO user_entity_stats_daily
                (user_id, bucket_date, entity_type, entity_id, play_count, weighted_play_count,
                 total_duration_ms, first_played_at, last_played_at, is_first_ever,
                 display_title, display_subtitle, display_cover)
            VALUES ${tuples.join(", ")}
            ON DUPLICATE KEY UPDATE
                play_count = VALUES(play_count),
                weighted_play_count = VALUES(weighted_play_count),
                total_duration_ms = VALUES(total_duration_ms),
                first_played_at = VALUES(first_played_at),
                last_played_at = VALUES(last_played_at),
                is_first_ever = VALUES(is_first_ever),
                display_title = VALUES(display_title),
                display_subtitle = VALUES(display_subtitle),
                display_cover = VALUES(display_cover)
        `, values);
    });

    await rollupHours(userId, dateKey, events, tzOffsetMinutes, config);

    return entries.length;
}

/**
 * The hour-of-day histogram for one local day.
 *
 * Hours are resolved in the user's local time here, at rollup, rather than at read time - so a chart built
 * from these rows keeps saying "you listen at 8am" even if the user later moves time zone, instead of
 * silently redistributing years of history.
 */
async function rollupHours(userId: string, dateKey: string, events: RawEventForRollup[], tzOffsetMinutes: number, config: InsightsConfig): Promise<void> {
    const byHour = new Map<number, { plays: number, durationMs: number }>();

    for (const event of events) {
        const { hour } = localParts(event.started_at.getTime(), tzOffsetMinutes);
        const entry = byHour.get(hour) ?? { plays: 0, durationMs: 0 };

        const weight = eventWeight({
            durationMs: Number(event.duration_ms) || 0,
            completed: event.completed === 1,
            trackDurationMs: event.track_duration === null ? 0 : Number(event.track_duration) * 1000
        }, config);

        if (weight > 0) entry.plays += 1;
        entry.durationMs += Number(event.duration_ms) || 0;
        byHour.set(hour, entry);
    }

    if (byHour.size === 0) return;

    const tuples: string[] = [];
    // typed concretely rather than unknown[], which mysql2's execute() will not accept
    const values: (string | number | null)[] = [];
    for (const [hour, entry] of byHour) {
        tuples.push("(?, ?, ?, ?, ?)");
        values.push(userId, dateKey, hour, entry.plays, entry.durationMs);
    }

    await withTransaction(async (conn) => {
        await conn.execute(`
            INSERT INTO user_hour_stats_daily (user_id, bucket_date, hour, play_count, total_duration_ms)
            VALUES ${tuples.join(", ")}
            ON DUPLICATE KEY UPDATE
                play_count = VALUES(play_count),
                total_duration_ms = VALUES(total_duration_ms)
        `, values);
    });
}

// --- monthly / yearly -------------------------------------------------------------------------------

interface BucketRow {
    entity_type: EntityType,
    entity_id: string,
    weighted_play_count: string | number,
    total_duration_ms: string | number,
    last_played_at: Date | null,
    display_title: string | null,
    display_subtitle: string | null,
    display_cover: string | null
}

type BucketLevel = "monthly" | "yearly";

// hard-coded per level; nothing here is ever built from caller input
const LEVELS = {
    monthly: {
        table: "user_entity_stats_monthly",
        bucketColumns: "bucket_year, bucket_month",
        bucketPlaceholders: ":year, :month",
        bucketPredicate: "bucket_year = :year AND bucket_month = :month"
    },
    yearly: {
        table: "user_entity_stats_yearly",
        bucketColumns: "bucket_year",
        bucketPlaceholders: ":year",
        bucketPredicate: "bucket_year = :year"
    }
} as const;

async function rollupBucket(
    userId: string,
    level: BucketLevel,
    bucket: { year: number, month?: number },
    range: { startMs: number, endMs: number }
): Promise<number> {
    const config = await getInsightsConfig();
    const spec = LEVELS[level];
    const params = { userId, year: bucket.year, month: bucket.month ?? 0, from: toMysqlDate(range.startMs), to: toMysqlDate(range.endMs) };

    // step 1: sum the daily rows into the bucket. Pure SQL - no weighting decisions are made here, the daily
    // table already holds weighted counts.
    await getLibrariesDb().prepare(`
        INSERT INTO ${spec.table}
            (user_id, ${spec.bucketColumns}, entity_type, entity_id, play_count, weighted_play_count,
             total_duration_ms, first_played_at, last_played_at, is_first_ever)
        SELECT :userId, ${spec.bucketPlaceholders}, entity_type, entity_id,
               SUM(play_count), SUM(weighted_play_count), SUM(total_duration_ms),
               MIN(first_played_at), MAX(last_played_at), MAX(is_first_ever)
        FROM user_entity_stats_daily
        WHERE user_id = :userId AND bucket_date >= :from AND bucket_date < :to
        GROUP BY entity_type, entity_id
        ON DUPLICATE KEY UPDATE
            play_count = VALUES(play_count),
            weighted_play_count = VALUES(weighted_play_count),
            total_duration_ms = VALUES(total_duration_ms),
            first_played_at = VALUES(first_played_at),
            last_played_at = VALUES(last_played_at),
            is_first_ever = VALUES(is_first_ever)
    `).run(params);

    // step 2: read the bucket back, with each entity's display snapshot taken from its most recent daily row
    // in the window (titles and cover art can change between the start and end of a year)
    const rows = await getLibrariesDb().prepare(`
        SELECT b.entity_type, b.entity_id, b.weighted_play_count, b.total_duration_ms, b.last_played_at,
               d.display_title, d.display_subtitle, d.display_cover
        FROM ${spec.table} b
        LEFT JOIN user_entity_stats_daily d
            ON d.user_id = b.user_id
           AND d.entity_type = b.entity_type
           AND d.entity_id = b.entity_id
           AND d.bucket_date = (
               SELECT MAX(bucket_date) FROM user_entity_stats_daily
               WHERE user_id = b.user_id AND entity_type = b.entity_type AND entity_id = b.entity_id
                 AND bucket_date >= :from AND bucket_date < :to
           )
        WHERE b.user_id = :userId AND ${spec.bucketPredicate}
    `).all<BucketRow>(params);

    if (rows.length === 0) return 0;

    // step 3: score and rank per entity type, then write both back
    const tuples: string[] = [];
    // typed concretely rather than unknown[], which mysql2's execute() will not accept
    const values: (string | number | null)[] = [];

    for (const entityType of ["track", "album", "artist", "playlist"] as EntityType[]) {
        const ofType = rows.filter((r) => r.entity_type === entityType);
        if (ofType.length === 0) continue;

        const scorable: ScorableRow[] = ofType.map((r) => ({
            entityId: r.entity_id,
            // SECURITY-adjacent correctness trap: mysql2 returns DECIMAL and BIGINT aggregates as *strings*.
            // Without these casts the arithmetic below silently becomes string concatenation and every
            // ranking comes out plausible-looking but wrong.
            weightedPlayCount: Number(r.weighted_play_count),
            totalDurationMs: Number(r.total_duration_ms),
            lastPlayedAtMs: r.last_played_at ? r.last_played_at.getTime() : null
        }));

        const scored = scoreEntities(scorable, range.endMs, config);
        const byId = new Map(ofType.map((r) => [r.entity_id, r]));

        for (const row of scored) {
            const source = byId.get(row.entityId)!;
            tuples.push(level === "monthly" ? "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)" : "(?, ?, ?, ?, ?, ?, ?, ?, ?)");
            values.push(userId, bucket.year);
            if (level === "monthly") values.push(bucket.month ?? 0);
            values.push(
                entityType,
                row.entityId,
                row.score,
                row.rank,
                source.display_title?.slice(0, 255) ?? null,
                source.display_subtitle?.slice(0, 255) ?? null,
                source.display_cover ?? null
            );
        }
    }

    if (tuples.length === 0) return 0;

    await withTransaction(async (conn) => {
        await conn.execute(`
            INSERT INTO ${spec.table}
                (user_id, ${spec.bucketColumns}, entity_type, entity_id, score, rank_in_bucket,
                 display_title, display_subtitle, display_cover)
            VALUES ${tuples.join(", ")}
            ON DUPLICATE KEY UPDATE
                score = VALUES(score),
                rank_in_bucket = VALUES(rank_in_bucket),
                display_title = VALUES(display_title),
                display_subtitle = VALUES(display_subtitle),
                display_cover = VALUES(display_cover)
        `, values);
    });

    return rows.length;
}

export async function rollupMonth(userId: string, year: number, month: number, tzOffsetMinutes: number): Promise<number> {
    return await rollupBucket(userId, "monthly", { year, month }, monthBounds(year, month, tzOffsetMinutes));
}

export async function rollupYear(userId: string, year: number, tzOffsetMinutes: number): Promise<number> {
    return await rollupBucket(userId, "yearly", { year }, yearBounds(year, tzOffsetMinutes));
}

/**
 * Rolls one user forward from a single instant: the local day containing it, then the month and year that
 * day belongs to. This is the unit of work the scheduler repeats, and also what an on-demand "my numbers
 * look stale" refresh would call.
 */
export async function rollupUserAt(userId: string, atMs: number, tzOffsetMinutes: number): Promise<void> {
    const dateKey = localDateKey(atMs, tzOffsetMinutes);
    // indexed rather than destructured: localDateKey always returns YYYY-MM-DD, but the compiler cannot
    // know that, and Number(undefined) would silently become NaN
    const parts = dateKey.split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);

    await rollupDay(userId, dateKey, tzOffsetMinutes);
    await rollupMonth(userId, year, month, tzOffsetMinutes);
    await rollupYear(userId, year, tzOffsetMinutes);
}
