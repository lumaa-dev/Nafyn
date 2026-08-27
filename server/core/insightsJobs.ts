// scheduled background work for listening insights: rollups, the weekly Replay Mix rebuild, the December
// snapshot, reel rendering and the retention sweep.
//
// Nafyn has no job queue (bullmq is a dependency but has never been wired up, and there is no Redis), so
// this is an in-process interval driven by server/plugins/insightsJobs.ts. What keeps that honest across
// restarts - and across replicas, if anyone runs more than one - is `insight_job_runs`: a job/period pair is
// claimed by an atomic conditional update, and a claim only succeeds when nobody else holds it.
//
//   - a period already marked 'done' is never reclaimed, so a restart cannot run it twice
//   - a 'running' claim whose heartbeat has gone stale IS reclaimable, so a crash mid-job cannot skip it
import { randomUUID } from "node:crypto";
import { getLibrariesDb, getUsersDb } from "./db";
import { getInsightsConfig } from "./insightsConfig";
import { getUsersWithEventsInWindow, pruneEventsOlderThan } from "./playEvents";
import { rollupDay, rollupMonth, rollupYear } from "./insightsAggregate";
import { rebuildReplayMix, rebuildAllTime } from "./replayMix";
import { snapshotYear } from "./insightsSnapshot";
import { renderQueuedReels } from "./insightsReel";
import { getInsightSettings } from "./insightsSettings";
import {
    localDateKey, localIsoWeek, monthBounds, yearBounds, previousMonth,
    DAY_MS
} from "~~/server/utils/insightsPeriod";

/** identifies this process in insight_job_runs. Purely for observability - the claim itself is atomic. */
const INSTANCE_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** a claim older than this with no heartbeat is assumed dead and may be taken over */
const STALE_CLAIM_MINUTES = 15;

export type JobName =
    | "rollup-daily"
    | "rollup-monthly"
    | "rollup-yearly"
    | "replay-weekly"
    | "year-snapshot"
    | "reel-render"
    | "retention-prune";

/**
 * Atomically claims (job, period) for this instance.
 *
 * The INSERT ... ON DUPLICATE KEY UPDATE only flips a row to 'running' when it is not already running, or
 * when its heartbeat has aged out. locked_by is then re-read: if it doesn't name this instance, somebody
 * else won the race and this process must not run the job.
 */
async function claimJob(job: JobName, periodKey: string): Promise<boolean> {
    const db = getLibrariesDb();

    // Step 1: first process to reach a brand-new period wins it outright. INSERT IGNORE turns the
    // primary-key collision every other process gets into a no-op instead of an error.
    const inserted = await db.prepare(`
        INSERT IGNORE INTO insight_job_runs (job_name, period_key, status, locked_by, locked_at, heartbeat_at, attempts)
        VALUES (:job, :period, 'running', :instance, NOW(3), NOW(3), 1)
    `).run({ job, period: periodKey, instance: INSTANCE_ID });

    if (inserted.changes > 0) return true;

    // Step 2: the row already exists, so take it over only if it is genuinely free - not finished, and
    // either idle or abandoned by a process that stopped heartbeating.
    //
    // Expressed as a conditional UPDATE rather than ON DUPLICATE KEY UPDATE with IF() guards, because MySQL
    // evaluates those assignments left to right against the *already updated* row: setting heartbeat_at to
    // NOW(3) first would make the staleness test in every later assignment read the new value and succeed,
    // handing the job to a second process. A single UPDATE ... WHERE has no such ordering hazard - the
    // predicate is evaluated once, under the row lock, and affectedRows says whether this process won.
    //
    // STALE_CLAIM_MINUTES is a module constant, never caller input; INTERVAL cannot take a placeholder.
    const claimed = await db.prepare(`
        UPDATE insight_job_runs
        SET status = 'running', locked_by = :instance, locked_at = NOW(3), heartbeat_at = NOW(3), attempts = attempts + 1, error = NULL
        WHERE job_name = :job AND period_key = :period
          AND status <> 'done'
          AND (status <> 'running' OR heartbeat_at IS NULL OR heartbeat_at < NOW(3) - INTERVAL ${STALE_CLAIM_MINUTES} MINUTE)
    `).run({ job, period: periodKey, instance: INSTANCE_ID });

    return claimed.changes > 0;
}

async function finishJob(job: JobName, periodKey: string, error?: unknown): Promise<void> {
    await getLibrariesDb().prepare(`
        UPDATE insight_job_runs
        SET status = :status, finished_at = NOW(3), heartbeat_at = NOW(3), error = :error
        WHERE job_name = :job AND period_key = :period AND locked_by = :instance
    `).run({
        job,
        period: periodKey,
        instance: INSTANCE_ID,
        status: error ? "failed" : "done",
        // the message only; a stack trace in a database column helps nobody and can carry paths
        error: error ? String((error as Error)?.message ?? error).slice(0, 1000) : null
    });
}

async function heartbeat(job: JobName, periodKey: string): Promise<void> {
    await getLibrariesDb().prepare(`
        UPDATE insight_job_runs SET heartbeat_at = NOW(3)
        WHERE job_name = :job AND period_key = :period AND locked_by = :instance
    `).run({ job, period: periodKey, instance: INSTANCE_ID });
}

/**
 * Claims the job, runs it, records the outcome. A failure is recorded and swallowed - a background rollup
 * blowing up must never take the Nitro process down with it, and the next run will retry the same period
 * because a 'failed' row is claimable again.
 */
async function runJob(job: JobName, periodKey: string, work: (beat: () => Promise<void>) => Promise<void>): Promise<boolean> {
    if (!await claimJob(job, periodKey)) return false;

    try {
        await work(() => heartbeat(job, periodKey));
        await finishJob(job, periodKey);
        return true;
    } catch (error) {
        console.error(`[insights] job ${job} (${periodKey}) failed:`, error);
        await finishJob(job, periodKey, error).catch(() => {});
        return false;
    }
}

/** every user who has ever opted in - the work list for jobs that aren't driven by recent events */
async function optedInUsers(): Promise<string[]> {
    const rows = await getUsersDb()
        .prepare(`SELECT user_id FROM user_insight_settings WHERE history_enabled = 1`)
        .all<{ user_id: string }>();
    return rows.map((r) => r.user_id);
}

async function tzFor(userId: string): Promise<number> {
    return (await getInsightSettings(userId)).tzOffsetMinutes;
}

// --- the jobs ----------------------------------------------------------------------------------------

/**
 * Rolls up everyone with recent activity. Runs hourly and always covers *two* local days: the one in
 * progress and the one before it, so a late offline flush that backdates into yesterday still lands in the
 * right bucket instead of being missed forever.
 */
export async function jobRollupDaily(nowMs: number): Promise<void> {
    const periodKey = new Date(nowMs).toISOString().slice(0, 13); // hourly granularity

    await runJob("rollup-daily", periodKey, async (beat) => {
        // a two-day window in UTC comfortably covers both local days for any time zone
        const users = await getUsersWithEventsInWindow(nowMs - 2 * DAY_MS, nowMs + DAY_MS);

        for (const userId of users) {
            const tz = await tzFor(userId);

            for (const dayOffset of [1, 0]) {
                const dayMs = nowMs - dayOffset * DAY_MS;
                const dateKey = localDateKey(dayMs, tz);
                await rollupDay(userId, dateKey, tz);

                const parts = dateKey.split("-");
                const year = Number(parts[0]);
                const month = Number(parts[1]);
                await rollupMonth(userId, year, month, tz);
                await rollupYear(userId, year, tz);
            }

            await beat();
        }
    });
}

/**
 * Re-rolls the previous month for a few days after it ends, catching anything that arrived late, then the
 * current month. Daily rollups already keep both fresh; this is the belt-and-braces pass that guarantees a
 * closed month is final.
 */
export async function jobRollupMonthly(nowMs: number): Promise<void> {
    const periodKey = new Date(nowMs).toISOString().slice(0, 10);

    await runJob("rollup-monthly", periodKey, async (beat) => {
        for (const userId of await optedInUsers()) {
            const tz = await tzFor(userId);
            const now = new Date(nowMs + tz * 60_000);
            const year = now.getUTCFullYear();
            const month = now.getUTCMonth() + 1;

            await rollupMonth(userId, year, month, tz);

            // only for the first few days of a month, when the one just ended can still gain events
            if (now.getUTCDate() <= 3) {
                const prev = previousMonth(year, month);
                await rollupMonth(userId, prev.year, prev.month, tz);
                await rollupYear(userId, prev.year, tz);
            }

            await beat();
        }
    });
}

export async function jobRollupYearly(nowMs: number): Promise<void> {
    const periodKey = new Date(nowMs).toISOString().slice(0, 10);

    await runJob("rollup-yearly", periodKey, async (beat) => {
        for (const userId of await optedInUsers()) {
            const tz = await tzFor(userId);
            const year = new Date(nowMs + tz * 60_000).getUTCFullYear();
            await rollupYear(userId, year, tz);
            await beat();
        }
    });
}

/**
 * The weekly Replay Mix rebuild. Keyed on the ISO week, so it runs once per week no matter how many times
 * the process restarts inside it.
 */
export async function jobReplayWeekly(nowMs: number): Promise<void> {
    const { year: isoYear, week } = localIsoWeek(nowMs, 0);
    const periodKey = `${isoYear}-W${String(week).padStart(2, "0")}`;

    await runJob("replay-weekly", periodKey, async (beat) => {
        for (const userId of await optedInUsers()) {
            const tz = await tzFor(userId);
            const year = new Date(nowMs + tz * 60_000).getUTCFullYear();

            await rebuildReplayMix(userId, year);
            await rebuildAllTime(userId);
            await beat();
        }
    });
}

/**
 * Freezes the year-end package at the start of December and queues the highlight reel.
 *
 * Snapshotting in December rather than on New Year's Day is deliberate and matches the spec: the year-end
 * experience is something people look at *during* December.
 */
export async function jobYearSnapshot(nowMs: number): Promise<void> {
    const year = new Date(nowMs).getUTCFullYear();

    await runJob("year-snapshot", String(year), async (beat) => {
        for (const userId of await optedInUsers()) {
            const tz = await tzFor(userId);
            await snapshotYear(userId, year, tz);
            await beat();
        }
    });
}

/** drains queued highlight-reel renders. Period-keyed by the hour so a stuck render can't wedge it forever. */
export async function jobReelRender(nowMs: number): Promise<void> {
    const periodKey = new Date(nowMs).toISOString().slice(0, 13);
    await runJob("reel-render", periodKey, async () => { await renderQueuedReels(); });
}

export async function jobRetentionPrune(nowMs: number): Promise<void> {
    const periodKey = new Date(nowMs).toISOString().slice(0, 10);

    await runJob("retention-prune", periodKey, async () => {
        const config = await getInsightsConfig();
        // 0 means keep forever, which is the shipped default - see insightsConfig.ts for why
        if (config.rawEventRetentionDays <= 0) return;
        const removed = await pruneEventsOlderThan(config.rawEventRetentionDays);
        if (removed > 0) console.info(`[insights] retention sweep removed ${removed} raw events`);
    });
}

// --- the tick ----------------------------------------------------------------------------------------

/**
 * One scheduler tick. Decides purely from the wall clock which jobs are due; `insight_job_runs` then decides
 * whether this process is the one that gets to run them. Times are UTC, which is the right call for a
 * server-side schedule even though the *data* is bucketed per user's local calendar.
 */
export async function tickInsightsJobs(nowMs: number = Date.now()): Promise<void> {
    const now = new Date(nowMs);
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const weekday = now.getUTCDay(); // 1 = Monday
    const month = now.getUTCMonth() + 1;
    const date = now.getUTCDate();

    // hourly, on the hour
    if (minute < 5) await jobRollupDaily(nowMs);

    if (hour === 2 && minute < 5) await jobRollupMonthly(nowMs);
    if (hour === 2 && minute >= 30 && minute < 35) await jobRollupYearly(nowMs);
    if (weekday === 1 && hour === 3 && minute < 5) await jobReplayWeekly(nowMs);
    if (month === 12 && date === 1 && hour === 4 && minute < 5) await jobYearSnapshot(nowMs);
    if (hour === 4 && minute >= 30 && minute < 35) await jobRetentionPrune(nowMs);

    // every tick: renders are user-initiated and shouldn't wait for a scheduled slot
    await jobReelRender(nowMs);
}

/** on-demand refresh for one user - used after a manual "recompute my insights" request */
export async function refreshUserNow(userId: string, nowMs: number = Date.now()): Promise<void> {
    const tz = await tzFor(userId);
    const dateKey = localDateKey(nowMs, tz);
    // indexed rather than destructured: localDateKey always returns YYYY-MM-DD, but the compiler cannot
    // know that, and Number(undefined) would silently become NaN
    const parts = dateKey.split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);

    await rollupDay(userId, dateKey, tz);
    await rollupMonth(userId, year, month, tz);
    await rollupYear(userId, year, tz);
    await rebuildReplayMix(userId, year);
    await rebuildAllTime(userId);
}

export { monthBounds, yearBounds };
