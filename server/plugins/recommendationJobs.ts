// the recommender's scheduler (server/core/recJobs.ts): in-process, once a minute, like the other schedulers.
//
// Nitro runs plugins in alphabetical filename order, so db.ts (which creates the tables) has always finished
// before this one starts. NAFYN_REC_SCHEDULER=false makes a replica stand down: run it on ONE replica - it
// holds the serving models' online updates in memory and persists them, and two writers would overwrite each
// other's updates (decisions themselves are claimed safely either way).
import { tickRecommendations } from "~~/server/core/recJobs";
import { getRecConfig } from "~~/server/utils/recConfig";

const TICK_INTERVAL_MS = 60_000;

export default defineNitroPlugin(() => {
    if (import.meta.prerender) return;
    const config = getRecConfig();
    if (!config.enabled) {
        console.info("[recommendations] disabled by NAFYN_REC_ENABLED=false");
        return;
    }
    if (!config.scheduler) {
        console.info("[recommendations] scheduler disabled by NAFYN_REC_SCHEDULER=false");
        return;
    }

    let ticking = false;
    const run = async () => {
        if (ticking) return;
        ticking = true;
        try {
            await tickRecommendations();
        } catch (error) {
            console.error("[recommendations] scheduler tick failed:", error);
        } finally {
            ticking = false;
        }
    };

    const timer = setInterval(run, TICK_INTERVAL_MS);
    timer.unref?.();
    // first pass shortly after boot, once the rest of the server is up
    const first = setTimeout(run, 20_000);
    first.unref?.();
});
