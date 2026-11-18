import { describe, expect, test } from "bun:test";
import { Rng } from "../../server/utils/recommender/math";
import { SAMPLE_RATE, analyzePcm, estimateKey } from "../../server/utils/recommender/mixes/audio";
import { trainAls, similarUsers } from "../../server/utils/recommender/mixes/als";
import { ArtistGraph, countCooccurrences, ppmi, randomizedEmbedding } from "../../server/utils/recommender/mixes/graph";
import { camelot, harmonicDistance, sequence, tempoDistance, type SeqItem } from "../../server/utils/recommender/mixes/sequencer";
import { hungarian, matchToPrevious } from "../../server/utils/recommender/mixes/assemble";
import { rankNormalize } from "../../server/utils/recommender/mixes/candidates";
import { engagementWeight, sphericalKMeans, weightedSilhouette } from "../../server/utils/recommender/mixes/modes";
import { fallbackTitle } from "../../server/utils/recommender/mixes/types";
import { generateMixes, type MixEngineConfig } from "../../server/utils/recommender/mixes/pipeline";
import { generateWorld, syntheticProvider, trulyFits, userTracks } from "../../server/utils/recommender/synthetic";
import { DEFAULT_REC_CONFIG, readRecConfig } from "../../server/utils/recommender/config";
import type { AudioFeatures } from "../../server/utils/recommender/mixes/audio";

function tone(freqs: number[], seconds: number, clickBpm?: number): Float32Array {
    const n = Math.round(seconds * SAMPLE_RATE);
    const out = new Float32Array(n);
    const period = clickBpm ? Math.round((60 / clickBpm) * SAMPLE_RATE) : 0;
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (const f of freqs) s += Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE) / freqs.length;
        if (period) {
            const phase = i % period;
            // a short decaying click on every beat
            if (phase < 600) s += 0.9 * Math.exp(-phase / 80) * (((i * 7919) % 200) / 100 - 1);
            s *= 0.3;
        }
        out[i] = 0.5 * s;
    }
    return out;
}

describe("audio analysis", () => {
    test("tempo of a click track", () => {
        const f = analyzePcm(tone([], 20, 120))!;
        expect(f).not.toBeNull();
        expect(Math.abs(f.tempo - 120)).toBeLessThan(3);
        expect(f.danceability).toBeGreaterThan(0.3);
    });

    test("key of a C major chord, and of an A minor one", () => {
        const c = analyzePcm(tone([261.63, 329.63, 392.0, 130.81], 10))!;
        expect([c.key, c.mode]).toEqual([0, 1]);
        const am = analyzePcm(tone([220.0, 261.63, 329.63, 110.0], 10))!;
        expect([am.key, am.mode]).toEqual([9, 0]);
    });

    test("Krumhansl profiles: a G major scale weighting reads as G major", () => {
        const chroma = new Array(12).fill(0.1);
        for (const pc of [7, 9, 11, 0, 2, 4, 6]) chroma[pc] = 1;
        chroma[7] = 2;
        chroma[2] = 1.5;
        expect(estimateKey(chroma)).toMatchObject({ key: 7, mode: 1 });
    });

    test("silence and short signals are unknown, not defaults", () => {
        expect(analyzePcm(new Float32Array(SAMPLE_RATE * 10))).toBeNull();
        expect(analyzePcm(new Float32Array(SAMPLE_RATE))).toBeNull();
    });

    test("louder, denser audio has more energy", () => {
        const quiet = analyzePcm(Float32Array.from(tone([220], 10), (x) => x * 0.05))!;
        const loud = analyzePcm(tone([220, 1760, 3520], 10, 140))!;
        expect(loud.energy).toBeGreaterThan(quiet.energy);
    });
});

describe("collaborative filtering and graphs", () => {
    test("ALS puts users with the same taste together", () => {
        const data: { user: number, item: number, weight: number }[] = [];
        for (let u = 0; u < 20; u++) for (let i = 0; i < 30; i++) {
            const group = u < 10 ? 0 : 1;
            if ((i < 15 ? 0 : 1) === group && (u * 31 + i * 17) % 3 !== 0) data.push({ user: u, item: i, weight: 2 });
        }
        const model = trainAls(20, 30, data, { factors: 4, reg: 0.1, alpha: 10, iterations: 10, seed: 1 });
        const near = similarUsers(model, 0, 5).map((s) => s.user);
        expect(near.every((u) => u < 10)).toBe(true);
    });

    test("personalized PageRank prefers the seed's neighbourhood", () => {
        const g = new ArtistGraph();
        g.addEdge("a", "b", 1);
        g.addEdge("b", "c", 1);
        g.addEdge("x", "y", 1);
        g.addEdge("c", "x", 0.05);
        const r = g.personalizedPageRank(new Map([["a", 1]]));
        expect(r.get("b")!).toBeGreaterThan(r.get("c")!);
        expect(r.get("c")!).toBeGreaterThan(r.get("y") ?? 0);
        const total = [...r.values()].reduce((s, x) => s + x, 0);
        expect(total).toBeCloseTo(1, 6);
    });

    test("co-occurrence embeddings: tracks of the same playlists are close", () => {
        const groups = [[0, 1, 2, 3], [1, 2, 3, 0], [4, 5, 6, 7], [5, 6, 7, 4], [0, 2, 1], [4, 6, 5]];
        const emb = randomizedEmbedding(ppmi(countCooccurrences(8, groups)), 8, 3, 1);
        const cos = (a: Float64Array, b: Float64Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);
        expect(cos(emb[0]!, emb[1]!)).toBeGreaterThan(cos(emb[0]!, emb[5]!));
    });
});

describe("clustering", () => {
    test("spherical k-means separates well-separated groups, and silhouette is high", () => {
        const rng = new Rng(3);
        const centers = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const points: Float64Array[] = [];
        const truth: number[] = [];
        for (let c = 0; c < 3; c++) for (let i = 0; i < 20; i++) {
            points.push(Float64Array.from(centers[c]!, (x) => x + 0.1 * rng.normal()));
            truth.push(c);
        }
        const w = points.map(() => 1);
        const res = sphericalKMeans(points, w, 3, rng);
        for (let c = 0; c < 3; c++) {
            const labels = new Set(truth.map((t, i) => (t === c ? res.assignment[i] : -1)).filter((x) => x !== -1));
            expect(labels.size).toBe(1);
        }
        expect(weightedSilhouette(points, w, res.assignment, 3)).toBeGreaterThan(0.7);
    });

    test("engagement weights: saves > full streams > nothing > early skips", () => {
        const at = 0;
        expect(engagementWeight({ trackKey: "a", kind: "save", at }, 200_000)).toBeGreaterThan(engagementWeight({ trackKey: "a", kind: "stream", at, msPlayed: 200_000 }, 200_000));
        expect(engagementWeight({ trackKey: "a", kind: "stream", at, msPlayed: 200_000 }, 200_000)).toBeGreaterThan(0);
        expect(engagementWeight({ trackKey: "a", kind: "stream", at, msPlayed: 3_000 }, 200_000)).toBeLessThan(0);
    });
});

function af(over: Partial<AudioFeatures>): AudioFeatures {
    return { tempo: 120, key: 0, mode: 1, loudness: -10, energy: 0.5, valence: 0.5, danceability: 0.5, acousticness: 0.5, brightness: 0.5, timbre: new Array(8).fill(0), ...over };
}

describe("sequencing", () => {
    test("Camelot wheel", () => {
        expect(camelot(0, 1)).toEqual({ number: 8, letter: "B" }); // C major
        expect(camelot(9, 0)).toEqual({ number: 8, letter: "A" }); // A minor
        expect(camelot(7, 1)).toEqual({ number: 9, letter: "B" }); // G major
        expect(camelot(5, 1)).toEqual({ number: 7, letter: "B" }); // F major
        expect(harmonicDistance(af({ key: 0, mode: 1 }), af({ key: 9, mode: 0 }))).toBeCloseTo(1 / 3, 10); // relative minor
        expect(harmonicDistance(af({ key: 0, mode: 1 }), af({ key: 6, mode: 1 }))).toBe(1); // tritone
        expect(tempoDistance(af({ tempo: 128 }), af({ tempo: 64 }))).toBeLessThan(0.2); // half time
        expect(tempoDistance(af({ tempo: 128 }), af({ tempo: 100 }))).toBeGreaterThan(0.8);
    });

    test("constraints: artist separation and novel runs hold", () => {
        const rng = new Rng(5);
        const items: SeqItem[] = Array.from({ length: 30 }, (_, i) => ({
            key: `k${i}`, artistKey: `a${i % 6}`, familiar: i % 2 === 0,
            audio: af({ energy: rng.next(), key: rng.int(12), tempo: 90 + rng.int(60) }), score: rng.next()
        }));
        const order = sequence(items, { arc: "arc", artistSeparation: 3, maxNovelRun: 2, twoOptPasses: 3 });
        expect(new Set(order).size).toBe(30);
        let run = 0;
        order.forEach((idx, pos) => {
            for (let b = 1; b <= 3 && pos - b >= 0; b++) expect(items[order[pos - b]!]!.artistKey).not.toBe(items[idx]!.artistKey);
            run = items[idx]!.familiar ? 0 : run + 1;
            expect(run).toBeLessThanOrEqual(2);
        });
    });

    test("an energy arc peaks in the middle", () => {
        const items: SeqItem[] = Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, artistKey: `a${i}`, familiar: true, audio: af({ energy: i / 20 }), score: 0.5 }));
        const order = sequence(items, { arc: "arc", artistSeparation: 1, maxNovelRun: 5, twoOptPasses: 4 });
        const energy = order.map((i) => items[i]!.audio!.energy);
        const third = Math.floor(energy.length / 3);
        const mid = energy.slice(third, 2 * third).reduce((s, x) => s + x, 0) / third;
        const ends = (energy.slice(0, third).reduce((s, x) => s + x, 0) + energy.slice(-third).reduce((s, x) => s + x, 0)) / (2 * third);
        expect(mid).toBeGreaterThan(ends);
    });
});

describe("identities and fusion", () => {
    test("Hungarian finds the optimal assignment", () => {
        expect(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]])).toEqual([1, 0, 2]);
        expect(hungarian([[1, 2]])).toEqual([0]);
    });

    test("a refreshed mix keeps its id when it is still the same mode", () => {
        const a = Float64Array.from([1, 0, 0]);
        const b = Float64Array.from([0, 1, 0]);
        const ids = matchToPrevious([{ id: "A", centroid: a }, { id: "B", centroid: b }], [Float64Array.from([0.1, 0.99, 0]), Float64Array.from([0, 0, 1])]);
        expect(ids).toEqual(["B", null]);
    });

    test("rank normalization ignores missing sources", () => {
        expect(rankNormalize([3, undefined, 1, 2])).toEqual([1, undefined, 0, 0.5]);
    });

    test("titles", () => {
        expect(fallbackTitle({ kind: "genre", value: "hip hop" })).toBe("Hip Hop Mix");
        expect(fallbackTitle({ kind: "decade", value: "1990s", qualifier: { kind: "mood", value: "mellow" } })).toBe("1990s Mix · Mellow");
        expect(fallbackTitle({ kind: "time", value: "night" })).toBe("Late Night Mix");
    });
});

function engineConfig(): MixEngineConfig {
    const c = DEFAULT_REC_CONFIG;
    return {
        modes: { minMixes: 1, maxMixes: c.maxMixes, minTracksPerMode: c.minTracksPerMode, minModeShare: c.minModeShare, restarts: 3, recencyHalfLifeDays: c.recencyHalfLifeDays, seed: 1 },
        assemble: { mixLength: 30, familiarRatio: 0.5, maxTracksPerArtist: 4, sequence: { arc: "arc", artistSeparation: 2, maxNovelRun: 2, twoOptPasses: 2 } },
        sourceWeights: c.sourceWeights,
        audioShortlist: 10,
        minSimilarityToKeepId: 0.5
    };
}

describe("personalized mixes end to end (synthetic world)", () => {
    const world = generateWorld(7, { users: 8 });

    test("one mix per true listening mode, novel tracks that fit, constraints held", async () => {
        let fits = 0;
        let novel = 0;
        let modeCountError = 0;
        for (const user of world.users) {
            const res = await generateMixes(
                { now: world.now, tracks: userTracks(world, user), engagements: world.engagements.get(user.id)!, previous: [] },
                syntheticProvider(world),
                engineConfig()
            );
            expect(res.mixes.length).toBeGreaterThan(0);
            expect(res.mixes.length).toBeLessThanOrEqual(DEFAULT_REC_CONFIG.maxMixes);
            modeCountError += Math.abs(res.mixes.length - user.modes.length);
            const titles = res.mixes.map((m) => m.title);
            expect(new Set(titles).size).toBe(titles.length);
            const seen = new Set<string>();
            for (const mix of res.mixes) {
                for (const t of mix.tracks) {
                    const info = mix.info.get(t.key)!;
                    expect(info).toBeDefined();
                    if (!t.familiar) {
                        expect(seen.has(t.key)).toBe(false); // a suggestion is in one mix only
                        seen.add(t.key);
                        expect(info.owned).toBe(false);
                        expect(t.reason.kind).toBe("novel");
                        novel++;
                        if (trulyFits(world, user, info)) fits++;
                    } else {
                        expect(world.owned.get(user.id)!.has(t.key) || world.engagements.get(user.id)!.some((e) => e.trackKey === t.key)).toBe(true);
                    }
                }
            }
        }
        expect(novel).toBeGreaterThan(50);
        // novel picks must fit the user's real taste far better than chance (~1/4 of genres)
        expect(fits / novel).toBeGreaterThan(0.75);
        expect(modeCountError / world.users.length).toBeLessThan(1.5);
    });

    test("mix identities survive a refresh", async () => {
        const user = world.users[0]!;
        const input = { now: world.now, tracks: userTracks(world, user), engagements: world.engagements.get(user.id)!, previous: [] };
        const first = await generateMixes(input, syntheticProvider(world), engineConfig());
        const previous = first.mixes.map((m, i) => ({ id: `mix-${i}`, centroid: m.centroid }));
        const second = await generateMixes({ ...input, now: world.now + 86_400_000, previous }, syntheticProvider(world), engineConfig());
        const kept = second.mixes.filter((m) => m.previousId !== null).length;
        expect(kept).toBeGreaterThanOrEqual(Math.min(first.mixes.length, second.mixes.length) - 1);
    });
});

describe("configuration", () => {
    test("environment overrides, and refusals", () => {
        const { config, problems } = readRecConfig({ NAFYN_REC_LAMBDA: "1.5", NAFYN_REC_POLICY: "neural_ts", NAFYN_REC_MAX_MIXES: "50", NAFYN_REC_HIDDEN_SIZES: "64,32" });
        expect(config.lambda).toBe(1.5);
        expect(config.policy).toBe("neural_ts");
        expect(config.maxMixes).toBe(DEFAULT_REC_CONFIG.maxMixes);
        expect(config.hiddenSizes).toEqual([64, 32]);
        expect(problems.map((p) => p.variable)).toEqual(["NAFYN_REC_MAX_MIXES"]);
        expect(readRecConfig({ NAFYN_REC_ENABLED: "false" }).config.enabled).toBe(false);
        expect(readRecConfig({ NAFYN_REC_ENABLED: "0" }).config.enabled).toBe(true);
    });
});
