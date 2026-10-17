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
import { pruneNotifiedSubscriptions } from "~~/server/core/releaseSubscriptions";
import { sweepApnTokens } from "~~/server/utils/apn";

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

// an Apple device the app hasn't re-registered from in this long is almost certainly gone; the app refreshes
// its tokens on every launch
const APN_DEVICE_STALE_DAYS = 180;
// a delivered release subscription stays listed (as "out now") in Settings -> Notifications for this long
const NOTIFIED_SUBSCRIPTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function tick(): Promise<void> {
    const removed = await pruneRecentlyPlayedOlderThan(await recentlyPlayedRetentionDays());
    if (removed > 0) console.info(`[retention] removed ${removed} stale recently-played rows`);

    // push tokens of logins that no longer exist, devices long gone, update tokens of finished activities
    await sweepApnTokens(APN_DEVICE_STALE_DAYS);
    const subscriptions = await pruneNotifiedSubscriptions(NOTIFIED_SUBSCRIPTION_RETENTION_MS);
    if (subscriptions > 0) console.info(`[retention] removed ${subscriptions} delivered release subscriptions`);
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
