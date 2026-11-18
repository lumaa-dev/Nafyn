// Logging-time randomization and the propensities that make offline evaluation possible.
//
// IPS and DR re-weight a logged reward by pi_target(a|s) / pi_logging(a|s), so pi_logging(a|s) - the
// propensity - has to be known exactly for every logged decision and must never be 0 for an action the
// target policy could pick. A deterministic argmax policy has propensity 1 on one action and 0 elsewhere:
// nothing it never showed can be evaluated. So the served ranking is randomized, and the probability of what
// was shown is computed and logged at decision time:
//
//   epsilon-greedy: p(a) = (1 - eps) * [a = argmax Score] + eps / n
//   softmax:        p(a) = exp(Score(a) / tau) / sum_b exp(Score(b) / tau)
//   Thompson:       the randomness is lambda itself; p(a) = P(a has the highest sampled score), estimated by
//                   Monte Carlo over fresh lambda draws, then mixed with eps / n so it is never 0
//
// A slate (k cards out of n) is built position by position without replacement; every position is its own
// decision over what is left, with its own conditional propensity, and the slate's probability is their
// product. `exclusion` removes, after each pick, the other candidates for the same item (an item can be
// offered with several explanations, but shown once) - offline evaluation replays the exact same rule.
import { type Rng, argsortDesc, logSumExp } from "../math";

export type ExplorationSpec =
    | { kind: "epsilon", epsilon: number }
    | { kind: "softmax", temperature: number }
    | { kind: "none" };

export interface EpsilonSchedule {
    start: number,
    end: number,
    decaySteps: number
}

/** linear decay from `start` to `end` over `decaySteps` decisions, then flat */
export function epsilonAt(schedule: EpsilonSchedule, step: number): number {
    if (schedule.decaySteps <= 0) return schedule.end;
    const t = Math.min(1, Math.max(0, step / schedule.decaySteps));
    return schedule.start + (schedule.end - schedule.start) * t;
}

/** Resamples the scores of the given candidates (Thompson sampling): Score = mean + lambda * sigma, lambda fresh. */
export interface ScoreSampler {
    mean: Float64Array,
    sigma: Float64Array,
    nu: number
}

/**
 * The probability distribution over `available` candidates (indices into `scores`) for ONE position.
 * Deterministic scores: epsilon-greedy / softmax / argmax. With a sampler (Thompson), the argmax probability
 * is estimated from `mcSamples` draws and mixed with epsilon.
 */
export function positionDistribution(
    scores: ArrayLike<number>,
    available: readonly number[],
    spec: ExplorationSpec,
    rng: Rng | null,
    sampler?: ScoreSampler,
    mcSamples = 256
): Float64Array {
    const n = available.length;
    const probs = new Float64Array(n);
    if (n === 0) return probs;
    if (n === 1) {
        probs[0] = 1;
        return probs;
    }

    let greedy: Float64Array;
    if (sampler) {
        if (!rng) throw new Error("positionDistribution: Thompson sampling needs an rng");
        greedy = thompsonArgmaxProbabilities(sampler, available, rng, mcSamples);
    } else if (spec.kind === "softmax") {
        const logits = available.map((i) => scores[i]! / spec.temperature);
        const z = logSumExp(logits);
        for (let j = 0; j < n; j++) probs[j] = Math.exp(logits[j]! - z);
        return probs;
    } else {
        greedy = new Float64Array(n);
        let best = 0;
        for (let j = 1; j < n; j++) if (scores[available[j]!]! > scores[available[best]!]!) best = j;
        greedy[best] = 1;
    }

    const eps = spec.kind === "epsilon" ? spec.epsilon : 0;
    for (let j = 0; j < n; j++) probs[j] = (1 - eps) * greedy[j]! + eps / n;
    return probs;
}

/** P(candidate j has the highest sampled score), Monte Carlo over fresh lambda ~ N(0, nu^2) draws */
export function thompsonArgmaxProbabilities(sampler: ScoreSampler, available: readonly number[], rng: Rng, samples: number): Float64Array {
    const n = available.length;
    const wins = new Float64Array(n);
    for (let s = 0; s < samples; s++) {
        let best = -1;
        let bestScore = -Infinity;
        for (let j = 0; j < n; j++) {
            const i = available[j]!;
            const score = sampler.mean[i]! + sampler.nu * rng.normal() * sampler.sigma[i]!;
            if (score > bestScore) {
                bestScore = score;
                best = j;
            }
        }
        wins[best]! += 1;
    }
    for (let j = 0; j < n; j++) wins[j]! /= samples;
    return wins;
}

/**
 * One position's served choice among `available` (indices into `scores`), with its propensity. See
 * `selectSlate` for how each exploration kind chooses; this is that rule for a single position, used where
 * every position is scored with its own context (the card ranker: position is part of the context).
 */
export function choosePosition(
    scores: ArrayLike<number>,
    available: readonly number[],
    spec: ExplorationSpec,
    rng: Rng,
    options: { sampler?: ScoreSampler, mcSamples?: number, floor?: number } = {}
): { index: number, propensity: number } {
    const eps = spec.kind === "epsilon" ? spec.epsilon : 0;
    const mc = options.mcSamples ?? 256;
    let pickPos: number;
    let propensity: number;
    if (options.sampler) {
        const explore = eps > 0 && rng.next() < eps;
        let best = 0;
        for (let j = 1; j < available.length; j++) if (scores[available[j]!]! > scores[available[best]!]!) best = j;
        pickPos = explore ? rng.int(available.length) : best;
        const greedy = thompsonArgmaxProbabilities(options.sampler, available, rng, mc);
        const pTs = (greedy[pickPos]! * mc + (pickPos === best ? 1 : 0)) / (mc + 1);
        propensity = (1 - eps) * pTs + eps / available.length;
    } else {
        const dist = positionDistribution(scores, available, spec, null);
        pickPos = rng.categorical(dist);
        propensity = dist[pickPos]!;
    }
    return { index: available[pickPos]!, propensity: Math.max(options.floor ?? 0, propensity) };
}

export interface SlateChoice {
    /** chosen candidate indices, in display order */
    order: number[],
    /** propensity of each position's choice, conditional on the earlier positions */
    propensities: number[],
    /** product of the conditional propensities */
    slatePropensity: number
}

export type ExclusionRule = (chosen: number, candidate: number) => boolean;

export function remainingAfter(total: number, chosen: readonly number[], exclusion?: ExclusionRule): number[] {
    const out: number[] = [];
    for (let i = 0; i < total; i++) {
        if (chosen.includes(i)) continue;
        if (exclusion && chosen.some((c) => exclusion(c, i))) continue;
        out.push(i);
    }
    return out;
}

/**
 * Picks a slate of up to `k` candidates.
 *
 * `scores` are the scores this decision was served with (for Thompson sampling, one realized draw). The
 * served choice at each position follows the same distribution `positionDistribution` describes: with
 * epsilon-greedy, the argmax of `scores` among what is left w.p. 1 - eps, else a uniform pick; with softmax,
 * a draw from it; with Thompson sampling, the argmax of the realized draw (itself the random part) unless
 * epsilon picks uniformly. The logged propensity of a Thompson choice is the Monte Carlo estimate with the
 * realized draw counted as one more sample - (wins + 1) / (samples + 1) - so it is never 0 for what was shown.
 */
export function selectSlate(
    scores: Float64Array,
    k: number,
    spec: ExplorationSpec,
    rng: Rng,
    options: { sampler?: ScoreSampler, mcSamples?: number, exclusion?: ExclusionRule, floor?: number } = {}
): SlateChoice {
    const order: number[] = [];
    const propensities: number[] = [];

    while (order.length < k) {
        const available = remainingAfter(scores.length, order, options.exclusion);
        if (available.length === 0) break;
        // the realized draw decides (Thompson), unless epsilon explores
        const { index, propensity } = choosePosition(scores, available, spec, rng, options);
        order.push(index);
        propensities.push(propensity);
    }

    let slatePropensity = 1;
    for (const p of propensities) slatePropensity *= p;
    return { order, propensities, slatePropensity };
}

/** deterministic ranking (no exploration), for offline target policies and diagnostics */
export function greedyOrder(scores: ArrayLike<number>, k: number, exclusion?: ExclusionRule): number[] {
    const out: number[] = [];
    for (const i of argsortDesc(scores)) {
        if (out.length >= k) break;
        if (exclusion && out.some((c) => exclusion(c, i))) continue;
        out.push(i);
    }
    return out;
}
