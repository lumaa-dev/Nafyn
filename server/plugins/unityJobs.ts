// sweeps expired `sessions` rows (server/core/sessions.ts). Same in-process-interval rationale as
// server/plugins/insightsJobs.ts - no Redis, no worker process, just wake up and ask.
//
// Nitro runs plugins in alphabetical filename order, so db.ts (which creates the tables) has always finished
// before this one starts.
import { sweepExpiredSessions } from "~~/server/core/sessions";

const TICK_INTERVAL_MS = 60_000;

export default defineNitroPlugin(() => {
    if (process.env.NAFYN_UNITY_SCHEDULER === "false") {
        console.info("[unity] scheduler disabled by NAFYN_UNITY_SCHEDULER=false");
        return;
    }

    let ticking = false;

    const timer = setInterval(async () => {
        if (ticking) return;
        ticking = true;

        try {
            await sweepExpiredSessions();
        } catch (error) {
            console.error("[unity] scheduler tick failed:", error);
        } finally {
            ticking = false;
        }
    }, TICK_INTERVAL_MS);

    timer.unref?.();
});
