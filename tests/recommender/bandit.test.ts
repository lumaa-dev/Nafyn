import { describe, expect, test } from "bun:test";
import { Rng, addOuter, choleskySolve, cholesky, identity, matVec, normalQuantile, quadForm, shermanMorrisonUpdate, spdInverse } from "../../server/utils/recommender/math";
import { explorationScore, scoreActions } from "../../server/utils/recommender/bandit/score";
import { LinUcbPolicy } from "../../server/utils/recommender/bandit/linucb";
import { FactorizationMachine, Mlp, trainModel } from "../../server/utils/recommender/bandit/nn";
import { NeuralBanditPolicy, createNeuralBandit, type NeuralBanditOptions } from "../../server/utils/recommender/bandit/neuralTs";
import { epsilonAt, positionDistribution, selectSlate, thompsonArgmaxProbabilities } from "../../server/utils/recommender/bandit/exploration";
import { DEFAULT_REWARD_CONFIG, rewardFromEvents } from "../../server/utils/recommender/bandit/reward";
import { isValidExplanation, validExplanations, type ExplainableItem } from "../../server/utils/recommender/bandit/explanations";

function randomVec(rng: Rng, d: number): Float64Array {
    return Float64Array.from({ length: d }, () => rng.normal());
}

describe("Score(s, a) = r_hat + lambda * sigma", () => {
    test("the formula, exactly", () => {
        expect(explorationScore(0.3, 0.2, 1.5)).toBeCloseTo(0.6, 12);
        expect(explorationScore(0.3, 0.2, 0)).toBe(0.3);
        expect(explorationScore(0.3, 0.2, -1)).toBeCloseTo(0.1, 12);
    });

    test("scoreActions applies it to every candidate, for every policy", () => {
        const rng = new Rng(1);
        const lin = new LinUcbPolicy(5, { ridge: 1, lambda: 0.7, refactorEvery: 100 });
        for (let i = 0; i < 30; i++) lin.update(randomVec(rng, 5), rng.next());
        const ts = createNeuralBandit(5, "mlp", neuralOptions("ts"), new Rng(2));
        for (const policy of [lin, ts]) {
            const xs = Array.from({ length: 12 }, () => randomVec(rng, 5));
            const s = scoreActions(policy, xs, new Rng(3));
            for (let i = 0; i < xs.length; i++) {
                expect(s.score[i]!).toBeCloseTo(s.mean[i]! + s.lambda[i]! * s.sigma[i]!, 12);
                expect(s.sigma[i]!).toBeGreaterThanOrEqual(0);
            }
        }
    });
});

describe("LinUCB", () => {
    test("theta and sigma are the closed-form ridge solution", () => {
        const rng = new Rng(7);
        const d = 6;
        const policy = new LinUcbPolicy(d, { ridge: 2, lambda: 1, refactorEvery: 1_000_000 });
        const A = identity(d, 2);
        const b = new Float64Array(d);
        for (let t = 0; t < 200; t++) {
            const x = randomVec(rng, d);
            const r = rng.next();
            const w = 0.5 + rng.next();
            policy.update(x, r, w);
            addOuter(A, x, w);
            for (let j = 0; j < d; j++) b[j]! += w * r * x[j]!;
        }
        const L = cholesky(A);
        const theta = choleskySolve(L, b);
        const Ainv = spdInverse(A);
        const probe = Array.from({ length: 10 }, () => randomVec(rng, d));
        const { mean, sigma } = policy.predict(probe);
        probe.forEach((x, i) => {
            let m = 0;
            for (let j = 0; j < d; j++) m += theta[j]! * x[j]!;
            expect(mean[i]!).toBeCloseTo(m, 8);
            expect(sigma[i]!).toBeCloseTo(Math.sqrt(quadForm(Ainv, x)), 8);
        });
    });

    test("Sherman-Morrison tracks the exact inverse", () => {
        const rng = new Rng(11);
        const d = 8;
        const A = identity(d, 1);
        const Ainv = identity(d, 1);
        for (let t = 0; t < 500; t++) {
            const x = randomVec(rng, d);
            addOuter(A, x, 1);
            expect(shermanMorrisonUpdate(Ainv, x, 1)).toBe(true);
        }
        const exact = spdInverse(A);
        for (let i = 0; i < d * d; i++) expect(Ainv.data[i]!).toBeCloseTo(exact.data[i]!, 6);
    });

    test("serialization round-trips the model", () => {
        const rng = new Rng(5);
        const policy = new LinUcbPolicy(4, { ridge: 1, lambda: 0.5, refactorEvery: 10 });
        for (let t = 0; t < 50; t++) policy.update(randomVec(rng, 4), rng.next());
        const copy = LinUcbPolicy.deserialize(JSON.parse(JSON.stringify(policy.serialize())));
        const xs = [randomVec(rng, 4), randomVec(rng, 4)];
        const a = policy.predict(xs);
        const b = copy.predict(xs);
        for (let i = 0; i < 2; i++) {
            expect(b.mean[i]!).toBeCloseTo(a.mean[i]!, 9);
            expect(b.sigma[i]!).toBeCloseTo(a.sigma[i]!, 9);
        }
    });

    test("learns the best arm of a linear bandit", () => {
        const rng = new Rng(21);
        const d = 5;
        const truth = randomVec(rng, d);
        const arms = Array.from({ length: 20 }, () => randomVec(rng, d));
        const value = arms.map((a) => arms.length && a.reduce((s, x, j) => s + x * truth[j]!, 0));
        const best = value.indexOf(Math.max(...value));
        const policy = new LinUcbPolicy(d, { ridge: 1, lambda: 1, refactorEvery: 100 });
        for (let t = 0; t < 1500; t++) {
            const s = scoreActions(policy, arms, rng);
            const i = s.score.indexOf(Math.max(...s.score));
            policy.update(arms[i]!, value[i]! + 0.1 * rng.normal());
        }
        policy.lambda = 0;
        const greedy = scoreActions(policy, arms, rng);
        expect(greedy.score.indexOf(Math.max(...greedy.score))).toBe(best);
    });
});

function numericGradient(f: () => number, params: Float64Array, i: number, h = 1e-6): number {
    const old = params[i]!;
    params[i] = old + h;
    const up = f();
    params[i] = old - h;
    const down = f();
    params[i] = old;
    return (up - down) / (2 * h);
}

describe("differentiable models", () => {
    test("MLP gradient matches finite differences", () => {
        const rng = new Rng(3);
        const model = new Mlp(7, [6, 5], rng);
        const x = randomVec(rng, 7);
        const grad = new Float64Array(model.params.length);
        model.forwardGrad(x, grad);
        for (let i = 0; i < model.params.length; i += 3) {
            expect(grad[i]!).toBeCloseTo(numericGradient(() => model.forward(x), model.params, i), 5);
        }
        // the output layer's gradient is the last hidden layer plus the bias input
        const [offset, length] = model.lastLayer;
        const h = model.lastHidden(x);
        expect(h.length).toBe(length);
        for (let j = 0; j < length; j++) expect(grad[offset + j]!).toBeCloseTo(h[j]!, 10);
    });

    test("FM: Rendle's O(kn) form equals the pairwise sum, and its gradient is right", () => {
        const rng = new Rng(4);
        const fm = new FactorizationMachine(9, 4, rng);
        for (let i = 0; i < 1 + 9; i++) fm.params[i] = rng.normal();
        const x = randomVec(rng, 9);
        x[2] = 0;
        expect(fm.forward(x)).toBeCloseTo(fm.forwardNaive(x), 10);
        const grad = new Float64Array(fm.params.length);
        fm.forwardGrad(x, grad);
        for (let i = 0; i < fm.params.length; i++) {
            expect(grad[i]!).toBeCloseTo(numericGradient(() => fm.forward(x), fm.params, i), 5);
        }
    });

    test("training fits a smooth function", () => {
        const rng = new Rng(9);
        const xs = Array.from({ length: 400 }, () => randomVec(rng, 3));
        const ys = xs.map((x) => Math.sin(x[0]!) + 0.5 * x[1]! * x[2]!);
        const model = new Mlp(3, [32, 16], rng);
        const loss = trainModel(model, xs, ys, null, { loss: "mse", epochs: 200, batchSize: 32, learningRate: 0.01, reg: 0, rng });
        expect(loss).toBeLessThan(0.05);
    });
});

function neuralOptions(mode: "ts" | "ucb", uncertainty: "diag" | "last_layer" = "diag"): NeuralBanditOptions {
    return {
        mode, ridge: 1, nu: 0.5, uncertainty, learningRate: 0.01, trainEvery: 20, trainSteps: 30,
        trainBatch: 32, replayCapacity: 1000, hidden: [16, 16], fmRank: 4
    };
}

describe("Neural Thompson Sampling", () => {
    for (const uncertainty of ["diag", "last_layer"] as const) {
        test(`sigma shrinks where data accumulates (${uncertainty})`, () => {
            const rng = new Rng(13);
            const policy = createNeuralBandit(4, "mlp", { ...neuralOptions("ts", uncertainty), trainEvery: 1_000_000 }, rng);
            const x = randomVec(rng, 4);
            const before = policy.predict([x]).sigma[0]!;
            for (let t = 0; t < 50; t++) policy.update(x, 1);
            const after = policy.predict([x]).sigma[0]!;
            expect(after).toBeLessThan(before);
        });
    }

    test("lambda ~ N(0, nu^2) for TS, constant for UCB", () => {
        const ts = createNeuralBandit(3, "fm", neuralOptions("ts"), new Rng(1));
        const ucb = createNeuralBandit(3, "fm", neuralOptions("ucb"), new Rng(1));
        const l = ts.lambdas(20_000, new Rng(2));
        const m = l.reduce((s, x) => s + x, 0) / l.length;
        const v = l.reduce((s, x) => s + (x - m) ** 2, 0) / l.length;
        expect(Math.abs(m)).toBeLessThan(0.02);
        expect(Math.sqrt(v)).toBeCloseTo(0.5, 1);
        expect([...ucb.lambdas(5, new Rng(2))]).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
    });

    test("serialization round-trips", () => {
        const rng = new Rng(17);
        const policy = createNeuralBandit(4, "mlp", neuralOptions("ts", "last_layer"), rng);
        for (let t = 0; t < 40; t++) policy.update(randomVec(rng, 4), rng.next());
        const copy = NeuralBanditPolicy.deserialize(JSON.parse(JSON.stringify(policy.serialize())), new Rng(1));
        const xs = [randomVec(rng, 4)];
        expect(copy.predict(xs).mean[0]!).toBeCloseTo(policy.predict(xs).mean[0]!, 10);
        expect(copy.predict(xs).sigma[0]!).toBeCloseTo(policy.predict(xs).sigma[0]!, 10);
    });
});

describe("propensities", () => {
    test("every position distribution sums to 1", () => {
        const scores = Float64Array.from([0.1, 0.9, 0.4, 0.4, -1]);
        const available = [0, 1, 2, 4];
        for (const spec of [{ kind: "epsilon", epsilon: 0.2 }, { kind: "softmax", temperature: 0.3 }, { kind: "none" }] as const) {
            const p = positionDistribution(scores, available, spec, null);
            expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
        }
        const eps = positionDistribution(scores, available, { kind: "epsilon", epsilon: 0.2 }, null);
        expect(eps[1]!).toBeCloseTo(0.8 + 0.05, 12);
        expect(eps[0]!).toBeCloseTo(0.05, 12);
    });

    test("logged propensities match how often each slate is actually served", () => {
        const scores = Float64Array.from([0.5, 0.2, 0.9, 0.1]);
        const rng = new Rng(99);
        const counts = new Map<string, number>();
        const logged = new Map<string, number>();
        const runs = 40_000;
        for (let r = 0; r < runs; r++) {
            const s = selectSlate(scores, 2, { kind: "softmax", temperature: 0.4 }, rng);
            const key = s.order.join(",");
            counts.set(key, (counts.get(key) ?? 0) + 1);
            logged.set(key, s.slatePropensity);
        }
        for (const [key, n] of counts) expect(n / runs).toBeCloseTo(logged.get(key)!, 2);
        const total = [...logged.values()].reduce((s, p) => s + p, 0);
        expect(total).toBeCloseTo(1, 6);
    });

    test("Thompson argmax probability matches the analytic two-arm value", () => {
        const mean = Float64Array.from([0.5, 0.4]);
        const sigma = Float64Array.from([0.1, 0.2]);
        const nu = 1;
        const p = thompsonArgmaxProbabilities({ mean, sigma, nu }, [0, 1], new Rng(5), 100_000);
        const exact = 1 - normalCdf(-(0.5 - 0.4) / Math.sqrt(0.1 ** 2 + 0.2 ** 2));
        expect(p[0]!).toBeCloseTo(exact, 2);
    });

    test("epsilon schedule decays linearly then stays", () => {
        const s = { start: 0.2, end: 0.05, decaySteps: 100 };
        expect(epsilonAt(s, 0)).toBeCloseTo(0.2, 12);
        expect(epsilonAt(s, 50)).toBeCloseTo(0.125, 12);
        expect(epsilonAt(s, 1000)).toBeCloseTo(0.05, 12);
    });
});

function normalCdf(z: number): number {
    // via bisection on the quantile function, accurate enough for a test oracle
    let lo = 1e-12;
    let hi = 1 - 1e-12;
    for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        if (normalQuantile(mid) < z) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

describe("reward", () => {
    test("30-second rule and confidence", () => {
        expect(rewardFromEvents([{ kind: "play", msPlayed: 45_000 }]).value).toBe(1);
        expect(rewardFromEvents([{ kind: "play", msPlayed: 5_000 }]).value).toBe(0);
        // longer listening, more confidence
        expect(rewardFromEvents([{ kind: "play", msPlayed: 240_000 }]).confidence)
            .toBeGreaterThan(rewardFromEvents([{ kind: "play", msPlayed: 31_000 }]).confidence);
        // an earlier skip is a surer failure
        expect(rewardFromEvents([{ kind: "play", msPlayed: 2_000 }]).confidence)
            .toBeGreaterThan(rewardFromEvents([{ kind: "play", msPlayed: 25_000 }]).confidence);
        expect(rewardFromEvents([]).value).toBe(0);
        expect(rewardFromEvents([{ kind: "open" }, { kind: "request" }]).value).toBe(1);
        expect(rewardFromEvents([{ kind: "preview", msPlayed: 25_000 }], DEFAULT_REWARD_CONFIG).value).toBe(1);
        const graded = rewardFromEvents([{ kind: "play", msPlayed: 60_000 }], { ...DEFAULT_REWARD_CONFIG, graded: true }).value;
        expect(graded).toBeGreaterThan(0.6);
        expect(graded).toBeLessThan(1);
    });
});

describe("explanations", () => {
    const now = Date.UTC(2026, 10, 18);
    const ctx = { now, topArtists: new Set(["daft punk"]) };
    const base: ExplainableItem = {
        kind: "suggestion", owned: false, releasedAt: null, lastPlayedAt: null, addedAt: null,
        seedArtist: null, artists: ["Justice"], mixTitle: null, similarityToRecent: 0
    };

    test("an explanation must be true", () => {
        expect(isValidExplanation({ ...base, seedArtist: "Daft Punk" }, { kind: "because_artist", subject: "Daft Punk" }, ctx)).toBe(true);
        // not one of the user's artists
        expect(isValidExplanation({ ...base, seedArtist: "Air" }, { kind: "because_artist", subject: "Air" }, ctx)).toBe(false);
        // the item's own artist is not "because you listened to"
        expect(isValidExplanation({ ...base, artists: ["Daft Punk"], seedArtist: "Daft Punk" }, { kind: "because_artist", subject: "Daft Punk" }, ctx)).toBe(false);
        expect(isValidExplanation({ ...base, releasedAt: now - 10 * 86_400_000 }, { kind: "new_release" }, ctx)).toBe(true);
        expect(isValidExplanation({ ...base, releasedAt: now - 400 * 86_400_000 }, { kind: "new_release" }, ctx)).toBe(false);
        expect(isValidExplanation({ ...base, kind: "album", owned: true, lastPlayedAt: now - 90 * 86_400_000 }, { kind: "rediscover" }, ctx)).toBe(true);
        expect(isValidExplanation(base, { kind: "rediscover" }, ctx)).toBe(false);
    });

    test("validExplanations always offers none and nothing false", () => {
        const kinds = validExplanations({ ...base, seedArtist: "Daft Punk", similarityToRecent: 0.9 }, ctx).map((e) => e.kind);
        expect(kinds).toEqual(["none", "because_artist", "similar_to_recent"]);
    });
});
