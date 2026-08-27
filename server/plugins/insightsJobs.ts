// the listening-insights scheduler.
//
// An in-process interval rather than a job queue, because Nafyn has neither Redis nor a worker process and a
// self-hosted app shouldn't need either. Correctness across restarts and replicas comes from the
// `insight_job_runs` claim protocol in server/core/insightsJobs.ts, not from this file - all this does is
// wake up once a minute and ask.
//
// Nitro runs plugins in alphabetical filename order, so db.ts (which creates the tables) has always finished
// before this one starts.
import { tickInsightsJobs } from "~~/server/core/insightsJobs";

const TICK_INTERVAL_MS = 60_000;

export default defineNitroPlugin(() => {
    // lets a second replica stand down. The claim protocol makes concurrent schedulers correct anyway, but
    // correct-and-wasteful is still wasteful when one of them can simply not run.
    if (process.env.NAFYN_INSIGHTS_SCHEDULER === "false") {
        console.info("[insights] scheduler disabled by NAFYN_INSIGHTS_SCHEDULER=false");
        return;
    }

    let ticking = false;

    const timer = setInterval(async () => {
        // a tick that overruns a minute (a big December snapshot pass, say) must not have a second one
        // stacked on top of it
        if (ticking) return;
        ticking = true;

        try {
            await tickInsightsJobs();
        } catch (error) {
            // the individual jobs already record their own failures; anything reaching here is the scheduler
            // itself misbehaving, and it must never be allowed to kill the Nitro process
            console.error("[insights] scheduler tick failed:", error);
        } finally {
            ticking = false;
        }
    }, TICK_INTERVAL_MS);

    // without unref() this timer keeps the event loop alive and the process refuses to shut down cleanly
    timer.unref?.();
});
