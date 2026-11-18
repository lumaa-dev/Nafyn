// Counterfactual evaluation of a candidate policy on logged slates, and the gate a policy must pass before it
// serves anyone.
//
// Every position of every logged slate is one contextual-bandit decision: its context is the base context
// plus the position (contextAt), its action set is what was still available there (remainingAt), and its
// logged propensity is conditional on the earlier positions. Evaluating a target policy position by position
// on the logged prefixes estimates the value of its choice at each slot given what was already shown - the
// standard per-position ("item-position") reduction for slates, which assumes a slot's reward depends on the
// context and the item at that slot.
//
// The DR reward model is cross-fitted: logs are split by slate into K folds and the model scoring fold k is
// trained on the other K - 1, so q never predicts rewards it was fitted to (in-sample q makes the DR
// correction term artificially small and the interval falsely narrow).
import { type Rng, sigmoid } from "../math";
import { type ExplorationSpec, positionDistribution, thompsonArgmaxProbabilities } from "../bandit/exploration";
import type { FeatureSpace } from "../bandit/features";
import { type DiffModel, createModel, trainModel } from "../bandit/nn";
import type { BanditPolicy } from "../bandit/score";
import { type SlateLog, contextAt, remainingAt } from "../bandit/slate";
import { type Estimate, type LoggedTerm, directMethod, doublyRobust, doublyRobustImprovement, ips, onPolicyValue, snips } from "./estimators";

export interface PositionRecord {
    slate: number,
    position: number,
    context: Float64Array,
    actions: Float64Array[],
    available: number[],
    chosen: number,
    propensity: number,
    reward: number
}

/** flattens finished slates into one record per position (positions with no final reward are skipped) */
export function expandSlates(logs: readonly SlateLog[]): PositionRecord[] {
    const out: PositionRecord[] = [];
    logs.forEach((log, slate) => {
        for (let position = 0; position < log.order.length; position++) {
            const reward = log.rewards[position];
            if (reward === null || reward === undefined) continue;
            out.push({
                slate,
                position,
                context: contextAt(log, position),
                actions: log.actions,
                available: remainingAt(log, position),
                chosen: log.order[position]!,
                propensity: log.propensities[position]!,
                reward
            });
        }
    });
    return out;
}

/** a policy to evaluate: its probability over the available actions of one decision */
export interface TargetPolicy {
    name: string,
    distribution(context: Float64Array, actions: readonly Float64Array[], available: readonly number[], rng: Rng): Float64Array
}

/**
 * A bandit policy as it would serve: Score = r_hat + lambda * sigma, then the given exploration. For a
 * Thompson policy the argmax probability is estimated by Monte Carlo (deterministic given the rng seed).
 */
export function banditAsTarget(
    name: string,
    policy: BanditPolicy,
    space: FeatureSpace,
    joint: "linear" | "neural",
    exploration: ExplorationSpec,
    mcSamples = 512
): TargetPolicy {
    return {
        name,
        distribution(context, actions, available, rng) {
            const xs = available.map((i) => space.joint(joint, context, actions[i]!));
            const { mean, sigma } = policy.predict(xs);
            const local = available.map((_, j) => j);
            if (policy.stochastic) {
                const greedy = thompsonArgmaxProbabilities({ mean, sigma, nu: policy.nu ?? 1 }, local, rng, mcSamples);
                const eps = exploration.kind === "epsilon" ? exploration.epsilon : 0;
                return Float64Array.from(greedy, (g) => (1 - eps) * g + eps / local.length);
            }
            const lambda = policy.lambdas(xs.length, rng);
            const scores = Float64Array.from(mean, (m, j) => m + lambda[j]! * sigma[j]!);
            return positionDistribution(scores, local, exploration, rng);
        }
    };
}

// ---------------------------------------------------------------- reward model (direct method)

export interface RewardModelOptions {
    type: "fm" | "mlp",
    folds: number,
    epochs: number,
    hidden: number[],
    fmRank: number,
    learningRate: number,
    space: FeatureSpace
}

/** q(s, a) for every available action of every record, cross-fitted by slate */
export function crossFitRewardModel(records: readonly PositionRecord[], opts: RewardModelOptions, rng: Rng): Float64Array[] {
    const folds = Math.max(2, opts.folds);
    const slateFold = new Map<number, number>();
    for (const r of records) if (!slateFold.has(r.slate)) slateFold.set(r.slate, rng.int(folds));
    const q: Float64Array[] = records.map((r) => new Float64Array(r.available.length));

    for (let k = 0; k < folds; k++) {
        const train = records.filter((r) => slateFold.get(r.slate) !== k);
        const test = records.map((r, i) => [r, i] as const).filter(([r]) => slateFold.get(r.slate) === k);
        if (test.length === 0) continue;
        const model = fitRewardModel(train, opts, rng);
        for (const [r, i] of test) {
            r.available.forEach((a, j) => {
                q[i]![j] = model ? sigmoid(model.forward(opts.space.neural(r.context, r.actions[a]!))) : meanReward(train);
            });
        }
    }
    return q;
}

function meanReward(records: readonly PositionRecord[]): number {
    if (records.length === 0) return 0;
    return records.reduce((s, r) => s + r.reward, 0) / records.length;
}

export function fitRewardModel(records: readonly PositionRecord[], opts: RewardModelOptions, rng: Rng): DiffModel | null {
    if (records.length < 20) return null;
    const model = createModel(opts.type, opts.space.neuralDim, { hidden: opts.hidden, fmRank: opts.fmRank }, rng);
    trainModel(
        model,
        records.map((r) => opts.space.neural(r.context, r.actions[r.chosen]!)),
        records.map((r) => r.reward),
        null,
        { loss: "bce", epochs: opts.epochs, batchSize: 128, learningRate: opts.learningRate, reg: 1e-4, rng }
    );
    return model;
}

// ---------------------------------------------------------------- evaluation

export interface OffPolicyReport {
    policy: string,
    decisions: number,
    loggingPolicy: Estimate,
    ips: Estimate,
    ipsClipped: Estimate,
    snips: Estimate,
    dm: Estimate,
    dr: Estimate,
    drClipped: Estimate,
    /** V(candidate) - V(logging policy), paired on the same decisions (DR) */
    improvement: Estimate
}

export function evaluateTarget(
    records: readonly PositionRecord[],
    target: TargetPolicy,
    q: readonly Float64Array[],
    opts: { clip: number, confidence: number },
    rng: Rng
): OffPolicyReport {
    const terms: LoggedTerm[] = records.map((r, i) => {
        const probs = target.distribution(r.context, r.actions, r.available, rng);
        const chosenLocal = r.available.indexOf(r.chosen);
        if (chosenLocal < 0) throw new Error("logged choice was not among the available actions");
        let qTarget = 0;
        for (let j = 0; j < probs.length; j++) qTarget += probs[j]! * q[i]![j]!;
        return {
            reward: r.reward,
            loggingPropensity: r.propensity,
            targetProbability: probs[chosenLocal]!,
            qLogged: q[i]![chosenLocal]!,
            qTarget
        };
    });
    const c = { confidence: opts.confidence };
    return {
        policy: target.name,
        decisions: records.length,
        loggingPolicy: onPolicyValue(records.map((r) => r.reward), opts.confidence),
        ips: ips(terms, c),
        ipsClipped: ips(terms, { ...c, clip: opts.clip }),
        snips: snips(terms, c),
        dm: directMethod(terms, c),
        dr: doublyRobust(terms, c),
        drClipped: doublyRobust(terms, { ...c, clip: opts.clip }),
        improvement: doublyRobustImprovement(terms, c)
    };
}

// ---------------------------------------------------------------- safe policy update

export interface GateConfig {
    /** how far below the serving policy the candidate's value may possibly be (lower bound of the paired difference) */
    maxRegression: number,
    minEss: number,
    minDecisions: number
}

export interface GateDecision {
    accept: boolean,
    reason: string,
    improvement: number
}

/**
 * A candidate replaces the serving policy only when, on logged traffic, the lower confidence bound of its
 * paired DR improvement over what the serving policy actually earned is above -maxRegression - "with 95 %
 * confidence it is not worse by more than the tolerance" - with enough decisions and effective sample size
 * for the estimate to mean something.
 */
export function gate(report: OffPolicyReport, cfg: GateConfig): GateDecision {
    const improvement = report.improvement.value;
    const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4);
    if (report.decisions < cfg.minDecisions) {
        return { accept: false, reason: `only ${report.decisions} logged decisions (need ${cfg.minDecisions})`, improvement };
    }
    if (report.dr.ess < cfg.minEss) {
        return { accept: false, reason: `effective sample size ${report.dr.ess.toFixed(0)} < ${cfg.minEss}: the candidate chooses too differently from what was logged`, improvement };
    }
    const interval = `${fmt(improvement)} [${fmt(report.improvement.ciLow)}, ${fmt(report.improvement.ciHigh)}]`;
    if (report.improvement.ciLow < -cfg.maxRegression) {
        return { accept: false, reason: `could be worse than the serving policy: DR difference ${interval}, tolerance -${cfg.maxRegression}`, improvement };
    }
    return { accept: true, reason: `DR difference ${interval} vs the serving policy's ${report.loggingPolicy.value.toFixed(4)}`, improvement };
}
