// tunable knobs for the listening-insights ranking.
//
// These live in `app_settings` rather than environment variables so an installation can retune its rankings
// without a redeploy (and so an admin UI can expose them later). Defaults below are the shipped values; an
// app_settings row named `insights.<key>` overrides one.
import { getSetting, setSetting } from "./appSettings";

export const INSIGHTS_DEFAULTS = {
    // score = (alpha * normalized play count) + (beta * normalized listening time) + (gamma * recency decay)
    alpha: 0.4,
    beta: 0.5,
    gamma: 0.1,

    // plays shorter than this don't count as a play at all (though their duration is still real listening
    // time, and the raw event is still stored)
    minPlaySeconds: 30,
    discardUnderMinimum: true,
    underMinimumWeight: 0.1,

    // fraction of a track heard, below which the play reads as an early skip
    earlySkipRatio: 0.5,
    earlySkipWeight: 0.5,
    // fraction at/above which a play counts as complete even if the audio element never fired "ended"
    nearCompleteRatio: 0.85,
    // everything between an early skip and near-complete
    midWeight: 0.8,

    // exponential recency decay: a play this many days ago contributes half as much to the gamma term
    recencyHalfLifeDays: 30,

    replayMixSize: 100,

    // "enough data" gate - ranking surfaces stay hidden until a user clears one of these
    gateMinUniqueTracks: 20,
    gateMinMinutes: 60,

    // 0 means never prune. Deliberately the shipped default: the aggregates can only ever be rebuilt from
    // raw events, so pruning bakes any future bug in the weighting permanently into old buckets, and the raw
    // store is also what the personal data export reads from. Set a positive number once the scoring has
    // been through a full year unchanged.
    rawEventRetentionDays: 0
};

export type InsightsConfig = typeof INSIGHTS_DEFAULTS;

const SETTING_PREFIX = "insights.";
const CACHE_TTL_MS = 60_000;

let cache: { config: InsightsConfig, expiresAt: number } | null = null;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

// per-key bounds. Anything outside them is clamped rather than rejected - a bad app_settings row should
// degrade the ranking, never take the whole insights surface down.
const BOUNDS: Record<keyof InsightsConfig, [number, number]> = {
    alpha: [0, 1],
    beta: [0, 1],
    gamma: [0, 1],
    minPlaySeconds: [0, 3600],
    discardUnderMinimum: [0, 1],
    underMinimumWeight: [0, 1],
    earlySkipRatio: [0, 1],
    earlySkipWeight: [0, 1],
    nearCompleteRatio: [0, 1],
    midWeight: [0, 1],
    recencyHalfLifeDays: [1, 3650],
    replayMixSize: [1, 500],
    gateMinUniqueTracks: [0, 100_000],
    gateMinMinutes: [0, 10_000_000],
    rawEventRetentionDays: [0, 36_500]
};

export async function getInsightsConfig(): Promise<InsightsConfig> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) return cache.config;

    const config: InsightsConfig = { ...INSIGHTS_DEFAULTS };

    await Promise.all((Object.keys(INSIGHTS_DEFAULTS) as (keyof InsightsConfig)[]).map(async (key) => {
        const raw = await getSetting(`${SETTING_PREFIX}${key}`);
        if (raw === null) return;

        const fallback = INSIGHTS_DEFAULTS[key];
        if (typeof fallback === "boolean") {
            (config[key] as boolean) = raw === "true";
            return;
        }

        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return;
        const [min, max] = BOUNDS[key];
        (config[key] as number) = clamp(parsed, min, max);
    }));

    // all three weights at zero would make every score identically 0 and silently empty every ranking, which
    // looks exactly like "you have no listening history" - fall back rather than serve that
    if (config.alpha + config.beta + config.gamma <= 0) {
        config.alpha = INSIGHTS_DEFAULTS.alpha;
        config.beta = INSIGHTS_DEFAULTS.beta;
        config.gamma = INSIGHTS_DEFAULTS.gamma;
    }

    cache = { config, expiresAt: now + CACHE_TTL_MS };
    return config;
}

export async function setInsightsConfig(key: keyof InsightsConfig, value: number | boolean): Promise<void> {
    if (!(key in INSIGHTS_DEFAULTS)) throw new Error(`Unknown insights config key: ${key}`);
    await setSetting(`${SETTING_PREFIX}${key}`, String(value));
    cache = null;
}

// used by tests and by the config endpoints, so a change is visible immediately rather than up to a minute later
export function invalidateInsightsConfigCache(): void {
    cache = null;
}
