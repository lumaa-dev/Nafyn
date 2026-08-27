// ranking maths for listening insights. Pure functions, no database access, no I/O - everything here is a
// deterministic transform of numbers, so it can be reasoned about (and tested) without a MySQL instance.
//
//     score = (alpha * normalized_play_count) + (beta * normalized_listening_time) + (gamma * recency_decay)
//
// Weights and thresholds all come from insightsConfig.ts.
import type { InsightsConfig } from "./insightsConfig";

export interface WeighableEvent {
    /** real wall-clock milliseconds the user actually spent listening */
    durationMs: number,
    /** the audio element reached the end of the file */
    completed: boolean,
    /** full length of the track, in milliseconds (media.duration is seconds, so callers multiply by 1000) */
    trackDurationMs: number
}

/**
 * How much one play counts toward *play count*. Between 0 and 1.
 *
 * Note this never scales listening *time* - `total_duration_ms` always accumulates the real wall-clock
 * milliseconds regardless of what this returns, because "total listening minutes" is defined as time
 * actually played. A weight of 0 means "this wasn't really a play", not "this didn't happen": the raw event
 * is still stored (the store is append-only, and it is what the personal data export reads), it simply
 * contributes nothing to the count half of the score.
 *
 * Repeat-mode listening gets no special treatment anywhere in this file. Each loop of a track arrives as its
 * own event with its own full duration and is weighted exactly like any other play. That is intentional and
 * specified: there are no caps, no dampening and no diminishing returns on replaying the same track. Please
 * don't add any.
 */
export function eventWeight(event: WeighableEvent, config: InsightsConfig): number {
    const durationMs = Math.max(0, event.durationMs);
    const trackDurationMs = Math.max(0, event.trackDurationMs);

    // a play can't be *more* than the whole track; a duration longer than the file usually means the tab sat
    // paused-but-not-pause-evented, and crediting it as >100% would poison the completion heuristic
    const ratio = trackDurationMs > 0 ? Math.min(1, durationMs / trackDurationMs) : 0;

    if (durationMs < config.minPlaySeconds * 1000 && !event.completed) {
        return config.discardUnderMinimum ? 0 : config.underMinimumWeight;
    }

    if (event.completed || ratio >= config.nearCompleteRatio) return 1;
    if (ratio < config.earlySkipRatio) return config.earlySkipWeight;
    return config.midWeight;
}

/** whether a play counts toward the raw (unweighted) play_count at all */
export function countsAsPlay(event: WeighableEvent, config: InsightsConfig): boolean {
    return eventWeight(event, config) > 0;
}

/**
 * Exponential recency decay in [0, 1]: 1 for something played right at the end of the window, 0.5 for
 * something last played one half-life earlier, and so on. Optional in the sense that gamma = 0 removes it.
 */
export function recencyDecay(lastPlayedAtMs: number, windowEndMs: number, halfLifeDays: number): number {
    if (!Number.isFinite(lastPlayedAtMs) || halfLifeDays <= 0) return 0;
    const ageMs = Math.max(0, windowEndMs - lastPlayedAtMs);
    const decay = Math.pow(2, -ageMs / (halfLifeDays * 86_400_000));
    return Math.min(1, Math.max(0, decay));
}

export interface ScorableRow {
    entityId: string,
    weightedPlayCount: number,
    totalDurationMs: number,
    lastPlayedAtMs: number | null
}

export interface ScoredRow extends ScorableRow {
    score: number,
    rank: number
}

/**
 * Scores and ranks one homogeneous set of rows - a single user, a single time window, a single entity type.
 *
 * Normalization is against the maximum within that set ("normalized against the user's own data in that
 * window"), not min-max: min-max would map the lowest-ranked entity to exactly 0 even when it has real plays
 * behind it, which reads as "this didn't count" on a chart. Dividing by the max keeps every non-zero entity
 * non-zero.
 */
export function scoreEntities(rows: ScorableRow[], windowEndMs: number, config: InsightsConfig): ScoredRow[] {
    if (rows.length === 0) return [];

    const maxPlays = Math.max(...rows.map((r) => r.weightedPlayCount), 0);
    const maxDuration = Math.max(...rows.map((r) => r.totalDurationMs), 0);

    const scored = rows.map((row) => {
        const normalizedPlays = maxPlays > 0 ? row.weightedPlayCount / maxPlays : 0;
        const normalizedTime = maxDuration > 0 ? row.totalDurationMs / maxDuration : 0;
        const recency = row.lastPlayedAtMs === null
            ? 0
            : recencyDecay(row.lastPlayedAtMs, windowEndMs, config.recencyHalfLifeDays);

        return {
            ...row,
            score: config.alpha * normalizedPlays + config.beta * normalizedTime + config.gamma * recency,
            rank: 0
        };
    });

    // entityId is the final tiebreak so ranks are stable across reruns. Without it, entities with identical
    // scores reshuffle on every weekly rebuild and the Replay Mix visibly churns for no reason at all.
    scored.sort((a, b) => (b.score - a.score) || (b.totalDurationMs - a.totalDurationMs) || a.entityId.localeCompare(b.entityId));
    scored.forEach((row, index) => { row.rank = index + 1; });

    return scored;
}
