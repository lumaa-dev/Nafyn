// Every tunable of the recommender, with its NAFYN_REC_* environment override. Pure (reads the env object it
// is given), so tests and scripts can build configs without touching process.env. Defaults are listed in
// .env.example; an unparsable or out-of-range value falls back to the default and is reported by
// server/utils/envCheck.ts rather than crashing the server.
import type { Source } from "./mixes/candidates";
import type { EnergyArc } from "./mixes/sequencer";
import type { PolicyKind } from "./bandit/score";

export interface RecConfig {
    enabled: boolean,
    scheduler: boolean,
    seed: number,
    // ---- mixes
    maxMixes: number,
    minTracksPerMode: number,
    minModeShare: number,
    mixLength: number,
    familiarRatio: number,
    maxTracksPerArtist: number,
    artistSeparation: number,
    maxNovelRun: number,
    energyArc: EnergyArc,
    recencyHalfLifeDays: number,
    sourceWeights: Record<Source, number>,
    candidatesPerMode: number,
    audioShortlist: number,
    refreshHours: number,
    refreshMinNewEvents: number,
    // ---- bandit
    policy: PolicyKind,
    lambda: number,
    ridge: number,
    refactorEvery: number,
    exploration: "epsilon" | "softmax" | "none",
    epsilonStart: number,
    epsilonEnd: number,
    epsilonDecaySteps: number,
    softmaxTemperature: number,
    propensityFloor: number,
    tsNu: number,
    tsPropensitySamples: number,
    neuralModel: "mlp" | "fm",
    neuralUncertainty: "diag" | "last_layer",
    hiddenSizes: number[],
    fmRank: number,
    learningRate: number,
    trainEvery: number,
    trainSteps: number,
    interactionDim: number,
    cardsPerShelf: number,
    maxShelves: number,
    rewardThresholdMs: number,
    gradedReward: boolean,
    rewardWindowMinutes: number,
    // ---- offline evaluation & safe updates
    ipsClip: number,
    drFolds: number,
    rewardModel: "fm" | "mlp",
    gateMaxRegression: number,
    gateMinEss: number,
    gateMinDecisions: number,
    evaluationDays: number,
    // ---- retention
    decisionRetentionDays: number
}

export const DEFAULT_REC_CONFIG: RecConfig = {
    enabled: true,
    scheduler: true,
    seed: 7,
    maxMixes: 8,
    minTracksPerMode: 6,
    minModeShare: 0.06,
    mixLength: 40,
    familiarRatio: 0.6,
    maxTracksPerArtist: 4,
    artistSeparation: 3,
    maxNovelRun: 2,
    energyArc: "arc",
    recencyHalfLifeDays: 45,
    sourceWeights: { collaborative: 0.35, audio: 0.25, text: 0.15, graph: 0.25 },
    candidatesPerMode: 120,
    audioShortlist: 12,
    refreshHours: 24,
    refreshMinNewEvents: 40,
    policy: "linucb",
    lambda: 0.8,
    ridge: 1,
    refactorEvery: 500,
    exploration: "epsilon",
    epsilonStart: 0.2,
    epsilonEnd: 0.05,
    epsilonDecaySteps: 5000,
    softmaxTemperature: 0.1,
    propensityFloor: 1e-4,
    tsNu: 0.5,
    tsPropensitySamples: 256,
    neuralModel: "mlp",
    neuralUncertainty: "diag",
    hiddenSizes: [32, 32],
    fmRank: 8,
    learningRate: 0.005,
    trainEvery: 50,
    trainSteps: 100,
    interactionDim: 16,
    cardsPerShelf: 10,
    maxShelves: 5,
    rewardThresholdMs: 30_000,
    gradedReward: false,
    rewardWindowMinutes: 30,
    ipsClip: 50,
    drFolds: 5,
    rewardModel: "fm",
    gateMaxRegression: 0.005,
    gateMinEss: 200,
    gateMinDecisions: 1000,
    evaluationDays: 30,
    decisionRetentionDays: 90
};

type Env = Record<string, string | undefined>;

export interface ConfigProblem {
    variable: string,
    message: string
}

const NUMBER_VARS: [env: string, key: keyof RecConfig, min: number, max: number, integer: boolean][] = [
    ["NAFYN_REC_SEED", "seed", 0, 2 ** 31, true],
    ["NAFYN_REC_MAX_MIXES", "maxMixes", 1, 10, true],
    ["NAFYN_REC_MIX_LENGTH", "mixLength", 5, 100, true],
    ["NAFYN_REC_FAMILIAR_RATIO", "familiarRatio", 0, 1, false],
    ["NAFYN_REC_RECENCY_HALF_LIFE_DAYS", "recencyHalfLifeDays", 1, 3650, false],
    ["NAFYN_REC_REFRESH_HOURS", "refreshHours", 1, 24 * 30, false],
    ["NAFYN_REC_REFRESH_MIN_EVENTS", "refreshMinNewEvents", 1, 100_000, true],
    ["NAFYN_REC_LAMBDA", "lambda", 0, 100, false],
    ["NAFYN_REC_RIDGE", "ridge", 1e-6, 1e6, false],
    ["NAFYN_REC_EPSILON_START", "epsilonStart", 0, 1, false],
    ["NAFYN_REC_EPSILON_END", "epsilonEnd", 0, 1, false],
    ["NAFYN_REC_EPSILON_DECAY_STEPS", "epsilonDecaySteps", 0, 1e9, true],
    ["NAFYN_REC_SOFTMAX_TEMPERATURE", "softmaxTemperature", 1e-6, 100, false],
    ["NAFYN_REC_TS_NU", "tsNu", 0, 100, false],
    ["NAFYN_REC_LEARNING_RATE", "learningRate", 1e-6, 1, false],
    ["NAFYN_REC_REWARD_THRESHOLD_MS", "rewardThresholdMs", 1000, 600_000, true],
    ["NAFYN_REC_REWARD_WINDOW_MINUTES", "rewardWindowMinutes", 1, 24 * 60, true],
    ["NAFYN_REC_IPS_CLIP", "ipsClip", 1.0001, 1e6, false],
    ["NAFYN_REC_DR_FOLDS", "drFolds", 2, 20, true],
    ["NAFYN_REC_GATE_MAX_REGRESSION", "gateMaxRegression", 0, 1, false],
    ["NAFYN_REC_GATE_MIN_DECISIONS", "gateMinDecisions", 1, 1e9, true],
    ["NAFYN_REC_DECISION_RETENTION_DAYS", "decisionRetentionDays", 1, 3650, true],
    ["NAFYN_REC_EVALUATION_DAYS", "evaluationDays", 1, 365, true],
    ["NAFYN_REC_GATE_MIN_ESS", "gateMinEss", 1, 1e9, false],
    ["NAFYN_REC_CARDS_PER_SHELF", "cardsPerShelf", 1, 30, true],
    ["NAFYN_REC_MAX_SHELVES", "maxShelves", 1, 5, true],
    ["NAFYN_REC_AUDIO_SHORTLIST", "audioShortlist", 0, 100, true],
    ["NAFYN_REC_CANDIDATES_PER_MODE", "candidatesPerMode", 10, 1000, true],
    ["NAFYN_REC_TS_PROPENSITY_SAMPLES", "tsPropensitySamples", 16, 10_000, true],
    ["NAFYN_REC_TRAIN_EVERY", "trainEvery", 1, 100_000, true],
    ["NAFYN_REC_TRAIN_STEPS", "trainSteps", 1, 100_000, true],
    ["NAFYN_REC_FM_RANK", "fmRank", 1, 64, true],
    ["NAFYN_REC_INTERACTION_DIM", "interactionDim", 1, 128, true],
    ["NAFYN_REC_REFACTOR_EVERY", "refactorEvery", 1, 1e9, true],
    ["NAFYN_REC_PROPENSITY_FLOOR", "propensityFloor", 1e-9, 0.5, false]
];

const CHOICE_VARS: [env: string, key: keyof RecConfig, choices: readonly string[]][] = [
    ["NAFYN_REC_POLICY", "policy", ["linucb", "neural_ts", "neural_ucb"]],
    ["NAFYN_REC_EXPLORATION", "exploration", ["epsilon", "softmax", "none"]],
    ["NAFYN_REC_NEURAL_MODEL", "neuralModel", ["mlp", "fm"]],
    ["NAFYN_REC_NEURAL_UNCERTAINTY", "neuralUncertainty", ["diag", "last_layer"]],
    ["NAFYN_REC_REWARD_MODEL", "rewardModel", ["fm", "mlp"]],
    ["NAFYN_REC_ENERGY_ARC", "energyArc", ["arc", "rise", "wave", "flat"]]
];

/** the config from the environment, plus every value it had to ignore and why */
export function readRecConfig(env: Env): { config: RecConfig, problems: ConfigProblem[] } {
    const config: RecConfig = { ...DEFAULT_REC_CONFIG, sourceWeights: { ...DEFAULT_REC_CONFIG.sourceWeights }, hiddenSizes: [...DEFAULT_REC_CONFIG.hiddenSizes] };
    const problems: ConfigProblem[] = [];
    const raw = (name: string) => {
        const v = env[name];
        return v === undefined || v.trim() === "" ? null : v.trim();
    };

    // only the exact value "false" switches a feature off, like every other NAFYN_* switch
    if (raw("NAFYN_REC_ENABLED") === "false") config.enabled = false;
    if (raw("NAFYN_REC_SCHEDULER") === "false") config.scheduler = false;
    const graded = raw("NAFYN_REC_GRADED_REWARD");
    if (graded !== null) config.gradedReward = graded === "true";

    for (const [name, key, min, max, integer] of NUMBER_VARS) {
        const v = raw(name);
        if (v === null) continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
            problems.push({ variable: name, message: `expected ${integer ? "an integer" : "a number"} in [${min}, ${max}]; the default is used` });
            continue;
        }
        (config as unknown as Record<string, number>)[key] = n;
    }
    for (const [name, key, choices] of CHOICE_VARS) {
        const v = raw(name);
        if (v === null) continue;
        if (!choices.includes(v)) {
            problems.push({ variable: name, message: `expected one of ${choices.join(", ")}; the default is used` });
            continue;
        }
        (config as unknown as Record<string, string>)[key] = v;
    }
    const hidden = raw("NAFYN_REC_HIDDEN_SIZES");
    if (hidden !== null) {
        const sizes = hidden.split(",").map((s) => Number(s.trim()));
        if (sizes.length === 0 || sizes.some((s) => !Number.isInteger(s) || s < 2 || s > 1024)) {
            problems.push({ variable: "NAFYN_REC_HIDDEN_SIZES", message: "expected comma-separated layer widths (2-1024); the default is used" });
        } else {
            config.hiddenSizes = sizes;
        }
    }
    if (config.epsilonEnd > config.epsilonStart) {
        problems.push({ variable: "NAFYN_REC_EPSILON_END", message: "is above NAFYN_REC_EPSILON_START; both defaults are used" });
        config.epsilonStart = DEFAULT_REC_CONFIG.epsilonStart;
        config.epsilonEnd = DEFAULT_REC_CONFIG.epsilonEnd;
    }
    if (config.exploration === "none" && config.policy !== "neural_ts") {
        problems.push({ variable: "NAFYN_REC_EXPLORATION", message: "\"none\" with a deterministic policy logs propensities of 1 and 0: new policies can no longer be evaluated offline" });
    }
    return { config, problems };
}
