// From what a person did with a recommendation to the reward the bandit learns from.
//
// The base rule is the streaming industry's: a stream that lasts longer than 30 seconds is a success, an early
// skip is a failure. Nafyn adds the two engagements a requestable suggestion allows (its 30-second preview, and
// requesting the download), and a recommendation that was shown and ignored counts as a failure once the
// attribution window closes - otherwise only clicked cards would ever carry a reward, and the propensities of
// everything else would be wasted.
//
// Confidence is a sample weight: a song listened to for five minutes says more than one that just crossed
// 30 seconds, and a skip after 2 seconds says more than one after 25.
export type FeedbackEvent =
    | { kind: "play", msPlayed: number }
    | { kind: "preview", msPlayed: number }
    | { kind: "request" }
    | { kind: "open" };

export interface RewardConfig {
    thresholdMs: number,
    graded: boolean,
    /** previews last 30 s, so their success bar is lower than a stream's */
    previewThresholdMs: number
}

export const DEFAULT_REWARD_CONFIG: RewardConfig = { thresholdMs: 30_000, graded: false, previewThresholdMs: 20_000 };

export interface Reward {
    /** binary: 0 or 1. graded: in [0, 1] */
    value: number,
    /** sample weight, >= 1 */
    confidence: number
}

function streamReward(ms: number, cfg: RewardConfig): Reward {
    const thr = cfg.thresholdMs;
    if (ms >= thr) {
        // longer listening, more confidence: +0.5 per doubling past the threshold, capped
        const confidence = Math.min(3, 1 + 0.5 * Math.log2(ms / thr));
        const value = cfg.graded ? Math.min(1, 0.6 + 0.4 * Math.min(1, (ms - thr) / (4 * thr))) : 1;
        return { value, confidence };
    }
    // an early skip: the earlier, the surer
    return { value: 0, confidence: 1 + Math.max(0, 1 - ms / thr) };
}

/** The reward of one slot from every event attributed to it in its window; no event at all = shown and ignored. */
export function rewardFromEvents(events: readonly FeedbackEvent[], cfg: RewardConfig = DEFAULT_REWARD_CONFIG): Reward {
    if (events.length === 0) return { value: 0, confidence: 1 };
    let best: Reward = { value: 0, confidence: 1 };
    let sawEngagement = false;
    for (const e of events) {
        let r: Reward;
        switch (e.kind) {
            case "request":
                r = { value: 1, confidence: 2 };
                break;
            case "play":
                r = streamReward(Math.max(0, e.msPlayed), cfg);
                break;
            case "preview": {
                const ok = e.msPlayed >= cfg.previewThresholdMs;
                r = { value: ok ? (cfg.graded ? 0.6 : 1) : 0, confidence: 1 };
                break;
            }
            case "open":
                r = { value: cfg.graded ? 0.1 : 0, confidence: 1 };
                break;
        }
        if (e.kind !== "open") sawEngagement = true;
        if (r.value > best.value || (r.value === best.value && r.confidence > best.confidence)) best = r;
    }
    // opening a card and leaving without listening is a mild negative, not a confident one
    if (!sawEngagement) best = { value: best.value, confidence: 1 };
    return best;
}
