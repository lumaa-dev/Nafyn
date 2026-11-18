// the recommender's scheduled work, one tick a minute (server/plugins/recommendationJobs.ts):
//   - close attribution windows and learn from them (every tick)
//   - measure audio of a few new library files (every tick, bounded)
//   - refresh the mixes of one due user (every tick; a refresh can take minutes, MusicBrainz' bulk lane)
//   - the daily offline evaluation and gate
//   - retention: decision logs, stale catalogue cache (hourly)
import { finalizeDecisions, pruneDecisions } from "./recBandit";
import { analyzePendingMedia } from "./recAudio";
import { nextDueUser, refreshUserMixes } from "./recMixes";
import { runDailyEvaluation } from "./recOffline";
import { pruneExternalCache } from "../utils/listenbrainz";
import { getRecConfig } from "../utils/recConfig";

const AUDIO_PER_TICK = 6;
let lastRetention = 0;
let refreshing: Promise<unknown> | null = null;

export async function tickRecommendations(): Promise<void> {
    if (!getRecConfig().enabled) return;
    const finalized = await finalizeDecisions();
    if (finalized > 0) console.info(`[recommendations] learned from ${finalized} closed decisions`);

    await analyzePendingMedia(AUDIO_PER_TICK);

    // a mix refresh runs in the background so it never holds the tick (and its finalization) for minutes
    if (!refreshing) {
        const userId = await nextDueUser();
        if (userId) {
            refreshing = refreshUserMixes(userId)
                .then((r) => r && console.info(`[recommendations] mixes refreshed for a user: ${r.mixes} mixes, ${r.suggestions} suggestions, ${Math.round(r.elapsedMs / 1000)} s`))
                .catch((error) => console.error("[recommendations] mix refresh failed:", error))
                .finally(() => {
                    refreshing = null;
                });
        }
    }

    await runDailyEvaluation();

    if (Date.now() - lastRetention > 3_600_000) {
        lastRetention = Date.now();
        const pruned = await pruneDecisions();
        if (pruned > 0) console.info(`[recommendations] removed ${pruned} expired ranking decisions`);
        await pruneExternalCache();
    }
}
