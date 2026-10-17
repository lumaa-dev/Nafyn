// release-subscription scheduler + download-progress wiring for push notifications.
//
// Ticks once a minute (same in-process-interval rationale as server/plugins/insightsJobs.ts - no queue, no
// Redis). Correctness across replicas comes from the claims in server/core/releaseSubscriptions.ts: each
// countdown start and each "out now" is a conditional UPDATE on its own row, so exactly one replica wins it.
// NAFYN_NOTIFICATION_SCHEDULER=false makes a replica stand down.
//
// Nitro runs plugins in alphabetical filename order, so db.ts (which creates the tables) has always finished
// before this one starts.
import { claimDueActivities, claimDueReleases, refreshReleaseDates } from "~~/server/core/releaseSubscriptions";
import { notifyReleaseOut, notifyReleaseSoon, startNotificationListeners } from "~~/server/core/notifications";

const TICK_INTERVAL_MS = 60_000;
// MusicBrainz dates move; pending subscriptions are re-resolved this often
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export default defineNitroPlugin(() => {
    // request Live Activities follow the download pipeline of *this* process, so every replica listens
    startNotificationListeners();

    if (process.env.NAFYN_NOTIFICATION_SCHEDULER === "false") {
        console.info("[notifications] scheduler disabled by NAFYN_NOTIFICATION_SCHEDULER=false");
        return;
    }

    let ticking = false;
    // first refresh a few minutes after boot rather than immediately: it is the one part that talks to MusicBrainz
    let lastRefresh = Date.now() - REFRESH_INTERVAL_MS + 5 * 60_000;

    const timer = setInterval(async () => {
        if (ticking) return;
        ticking = true;

        try {
            const now = Date.now();
            for (const sub of await claimDueActivities(now)) notifyReleaseSoon(sub);
            for (const sub of await claimDueReleases(now)) notifyReleaseOut(sub);

            if (now - lastRefresh >= REFRESH_INTERVAL_MS) {
                lastRefresh = now;
                const moved = await refreshReleaseDates();
                if (moved > 0) console.info(`[notifications] ${moved} release subscription date(s) moved`);
            }
        } catch (error) {
            console.error("[notifications] scheduler tick failed:", error);
        } finally {
            ticking = false;
        }
    }, TICK_INTERVAL_MS);

    timer.unref?.();
});
