// retention sweeps for the data stores that have no feature-level reason to grow forever
// (GDPR art. 5(1)(e), storage limitation).
//
// `recently_played` is the one that needed this: the shelf only ever displays the 20 most recent entries
// per user, but every row ever written stayed in the table - a per-account record of what was played and
// when, kept indefinitely, that nothing reads past the first 20. The insights store has its own sweep
// (server/core/insightsJobs.ts, "retention-prune"), so it is not touched here.
//
// Same in-process-interval rationale as the other schedulers: no queue, no Redis. Unlike the insights jobs
// there is no claim protocol, because both sweeps are plain idempotent deletes - two replicas running the
// same one at the same time just means the second finds nothing left to do.
//
// Nitro runs plugins in alphabetical filename order, so db.ts (which creates the tables) has always
// finished before this one starts.
import { pruneRecentlyPlayedOlderThan } from "~~/server/core/recentlyPlayed";
import { getSetting } from "~~/server/core/appSettings";

const TICK_INTERVAL_MS = 60 * 60 * 1000;

// six months. Well past any "recently" the shelf could mean, and it is capped at 20 displayed entries
// anyway. Overridable per install via the `retention.recentlyPlayedDays` app_settings row; 0 disables the
// sweep, which an operator should only do with a reason they can state.
const DEFAULT_RECENTLY_PLAYED_DAYS = 180;

async function recentlyPlayedRetentionDays(): Promise<number> {
    const raw = await getSetting("retention.recentlyPlayedDays");
    if (raw === null || raw === undefined || raw === "") return DEFAULT_RECENTLY_PLAYED_DAYS;

    const parsed = Number.parseInt(String(raw), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RECENTLY_PLAYED_DAYS;
}

async function tick(): Promise<void> {
    const removed = await pruneRecentlyPlayedOlderThan(await recentlyPlayedRetentionDays());
    if (removed > 0) console.info(`[retention] removed ${removed} stale recently-played rows`);
}

export default defineNitroPlugin(() => {
    if (process.env.NAFYN_RETENTION_SCHEDULER === "false") {
        console.info("[retention] scheduler disabled by NAFYN_RETENTION_SCHEDULER=false");
        return;
    }

    let ticking = false;

    const run = async () => {
        if (ticking) return;
        ticking = true;

        try {
            await tick();
        } catch (error) {
            console.error("[retention] scheduler tick failed:", error);
        } finally {
            ticking = false;
        }
    };

    // one pass shortly after boot, so an install that is restarted more often than the interval still
    // prunes; the tables are small enough that this costs nothing at startup
    const initial = setTimeout(run, 30_000);
    initial.unref?.();

    const timer = setInterval(run, TICK_INTERVAL_MS);
    timer.unref?.();
});
