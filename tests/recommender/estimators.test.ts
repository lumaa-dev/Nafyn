// Estimator unbiasedness under controlled conditions: a contextual bandit whose true reward probabilities
// are known, so the true value of any target policy can be computed exactly and every estimator's average
// over many independent logs compared to it.
import { describe, expect, test } from "bun:test";
import { Rng, sigmoid } from "../../server/utils/recommender/math";
import { type LoggedTerm, directMethod, doublyRobust, ips, snips } from "../../server/utils/recommender/offline/estimators";

const K = 5;
const D = 3;

interface World {
    theta: Float64Array[]
}

function makeWorld(seed: number): World {
    const rng = new Rng(seed);
    return { theta: Array.from({ length: K }, () => Float64Array.from({ length: D }, () => rng.normal())) };
}

function trueReward(w: World, s: Float64Array, a: number): number {
    let z = 0;
    for (let j = 0; j < D; j++) z += w.theta[a]![j]! * s[j]!;
    return sigmoid(z);
}

/** logging policy: softmax over a noisy preference - stochastic, every action has positive probability */
function loggingProbs(s: Float64Array): Float64Array {
    const logits = Float64Array.from({ length: K }, (_, a) => 0.6 * s[a % D]! * (a % 2 ? 1 : -1));
    const m = Math.max(...logits);
    const e = logits.map((x) => Math.exp(x - m));
    const z = e.reduce((x, y) => x + y, 0);
    return e.map((x) => x / z);
}

/** target policy: epsilon-greedy on the TRUE rewards (a good policy) */
function targetProbs(w: World, s: Float64Array): Float64Array {
    const r = Float64Array.from({ length: K }, (_, a) => trueReward(w, s, a));
    const best = r.indexOf(Math.max(...r));
    return Float64Array.from({ length: K }, (_, a) => 0.9 * (a === best ? 1 : 0) + 0.1 / K);
}

function context(rng: Rng): Float64Array {
    return Float64Array.from({ length: D }, () => rng.normal());
}

/** exact value of the target policy, by Monte Carlo over contexts only (no reward noise) */
function trueValue(w: World, rng: Rng, n = 200_000): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
        const s = context(rng);
        const p = targetProbs(w, s);
        for (let a = 0; a < K; a++) v += p[a]! * trueReward(w, s, a);
    }
    return v / n;
}

type QModel = (s: Float64Array, a: number) => number;

function simulate(w: World, rng: Rng, n: number, q: QModel, propensityNoise = 0): LoggedTerm[] {
    const terms: LoggedTerm[] = [];
    for (let i = 0; i < n; i++) {
        const s = context(rng);
        const mu = loggingProbs(s);
        const a = rng.categorical(mu);
        const r = rng.next() < trueReward(w, s, a) ? 1 : 0;
        const pi = targetProbs(w, s);
        let qTarget = 0;
        for (let b = 0; b < K; b++) qTarget += pi[b]! * q(s, b);
        // a WRONG propensity model: the logged propensity is distorted by a context-dependent factor
        const distortion = propensityNoise ? Math.exp(propensityNoise * s[0]! * (a % 2 ? 1 : -1)) : 1;
        terms.push({ reward: r, loggingPropensity: Math.min(1, mu[a]! * distortion), targetProbability: pi[a]!, qLogged: q(s, a), qTarget });
    }
    return terms;
}

function averageOver(runs: number, seed: number, estimate: (rng: Rng) => number): { mean: number, se: number } {
    const rng = new Rng(seed);
    const xs: number[] = [];
    for (let r = 0; r < runs; r++) xs.push(estimate(rng));
    const mean = xs.reduce((s, x) => s + x, 0) / runs;
    const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (runs - 1);
    return { mean, se: Math.sqrt(v / runs) };
}

describe("off-policy estimators", () => {
    const world = makeWorld(42);
    const truth = trueValue(world, new Rng(1));
    const correctQ: QModel = (s, a) => trueReward(world, s, a);
    const wrongQ: QModel = () => 0.5;

    test("IPS is unbiased with known propensities", () => {
        const { mean, se } = averageOver(300, 2, (rng) => ips(simulate(world, rng, 400, wrongQ)).value);
        expect(Math.abs(mean - truth)).toBeLessThan(4 * se + 1e-3);
    });

    test("SNIPS is consistent", () => {
        const est = snips(simulate(world, new Rng(3), 100_000, wrongQ)).value;
        expect(est).toBeCloseTo(truth, 2);
    });

    test("DR is unbiased with a WRONG reward model and correct propensities", () => {
        const { mean, se } = averageOver(300, 4, (rng) => doublyRobust(simulate(world, rng, 400, wrongQ)).value);
        expect(Math.abs(mean - truth)).toBeLessThan(4 * se + 1e-3);
        // and the direct method with that model is visibly biased - the case DR protects against
        const dm = directMethod(simulate(world, new Rng(5), 20_000, wrongQ)).value;
        expect(Math.abs(dm - truth)).toBeGreaterThan(0.02);
    });

    test("DR is unbiased with WRONG propensities and a correct reward model", () => {
        const { mean, se } = averageOver(300, 6, (rng) => doublyRobust(simulate(world, rng, 400, correctQ, 0.8)).value);
        expect(Math.abs(mean - truth)).toBeLessThan(4 * se + 1e-3);
        // IPS with those propensities is biased - the case DR protects against
        const biased = ips(simulate(world, new Rng(7), 100_000, correctQ, 0.8)).value;
        expect(Math.abs(biased - truth)).toBeGreaterThan(0.01);
    });

    test("propensity re-weighting: weights average to 1 under the logging policy", () => {
        const terms = simulate(world, new Rng(8), 100_000, wrongQ);
        const meanWeight = terms.reduce((s, t) => s + t.targetProbability / t.loggingPropensity, 0) / terms.length;
        expect(meanWeight).toBeCloseTo(1, 1);
    });

    test("clipping lowers the maximum weight and is reported", () => {
        const terms = simulate(world, new Rng(9), 5_000, wrongQ);
        const clipped = ips(terms, { clip: 2 });
        expect(clipped.maxWeight).toBeLessThanOrEqual(2);
        expect(clipped.clipped).toBeGreaterThan(0);
        expect(clipped.name).toBe("ips_clipped");
    });

    test("confidence intervals cover the truth at about the nominal rate", () => {
        const rng = new Rng(10);
        let covered = 0;
        const runs = 200;
        for (let r = 0; r < runs; r++) {
            const e = doublyRobust(simulate(world, rng, 800, wrongQ));
            if (e.ciLow <= truth && truth <= e.ciHigh) covered++;
        }
        expect(covered / runs).toBeGreaterThan(0.88);
    });

    test("a zero logged propensity is refused, not divided by", () => {
        expect(() => ips([{ reward: 1, loggingPropensity: 0, targetProbability: 1 }])).toThrow();
    });
});
