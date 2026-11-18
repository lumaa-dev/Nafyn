// bun run rec:simulate [--pages N] [--seed S] [--log file.jsonl]
//
// Online bandit ranking simulation of the Discover page on a synthetic environment whose reward probabilities
// are known: every policy serves the same stream of visitors, ranks shelves then cards with
// Score = r_hat + lambda * sigma, observes Bernoulli rewards, and learns online. Reports engagement, regret
// against the oracle (the true best card at every position) and scoring latency. `--log` writes the LinUCB
// run's decision log (context, candidates, choices, propensities, rewards) as JSON lines.
import { writeFileSync } from "node:fs";
import { Rng } from "../server/utils/recommender/math";
import { LinUcbPolicy } from "../server/utils/recommender/bandit/linucb";
import { createNeuralBandit } from "../server/utils/recommender/bandit/neuralTs";
import { cardContext, cardFeatureSpace, encodeContext, shelfFeatureSpace } from "../server/utils/recommender/bandit/features";
import { type PolicyBundle, rankPage } from "../server/utils/recommender/bandit/hierarchical";
import { remainingAt, type SlateLog } from "../server/utils/recommender/bandit/slate";
import type { BanditPolicy } from "../server/utils/recommender/bandit/score";
import { generateBanditEnv } from "../server/utils/recommender/synthetic";

const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const pages = Number(flag("--pages") ?? 1500);
const seed = Number(flag("--seed") ?? 11);
const logPath = flag("--log");

const env = generateBanditEnv(seed, 60, 400);
const cs = cardFeatureSpace(16);
const ss = shelfFeatureSpace(8);

function bundle(card: BanditPolicy): PolicyBundle {
    return {
        card, cardSpace: cs, cardJoint: card.kind === "linucb" ? "linear" : "neural",
        shelf: new LinUcbPolicy(ss.linearDim, { ridge: 1, lambda: 0.3, refactorEvery: 500 }), shelfSpace: ss
    };
}

const neural = (mode: "ts" | "ucb") => createNeuralBandit(cs.neuralDim, "mlp", {
    mode, ridge: 1, nu: mode === "ts" ? 0.3 : 0.3, uncertainty: "diag", learningRate: 0.005, trainEvery: 50, trainSteps: 60,
    trainBatch: 64, replayCapacity: 20_000, hidden: [32, 32], fmRank: 8
}, new Rng(seed + 1));

const contenders: [string, PolicyBundle, boolean][] = [
    ["random (no learning)", bundle(new LinUcbPolicy(cs.linearDim, { ridge: 1, lambda: 0, refactorEvery: 500 })), false],
    ["greedy LinUCB (lambda = 0)", bundle(new LinUcbPolicy(cs.linearDim, { ridge: 1, lambda: 0, refactorEvery: 500 })), true],
    ["LinUCB (lambda = 0.8)", bundle(new LinUcbPolicy(cs.linearDim, { ridge: 1, lambda: 0.8, refactorEvery: 500 })), true],
    ["Neural Thompson Sampling", bundle(neural("ts")), true],
    ["NeuralUCB", bundle(neural("ucb")), true]
];

console.log(`${pages} page views, ${env.users.length} users, ${env.items.length} items, 5 shelves x 6 cards\n`);
for (const [name, policies, learn] of contenders) {
    const rng = new Rng(seed * 7);
    let reward = 0;
    let oracle = 0;
    let shown = 0;
    const latencies: number[] = [];
    const curve: number[] = [];
    const logs: SlateLog[] = [];
    let windowReward = 0;
    let windowShown = 0;
    for (let p = 0; p < pages; p++) {
        const user = rng.pick(env.users);
        const hour = rng.int(24);
        const base = encodeContext(env.context(user, hour));
        const { shelves, lookup } = env.page(user, hour, rng);
        const page = rankPage(base, shelves, policies, {
            exploration: learn ? { kind: "epsilon", epsilon: Math.max(0.05, 0.2 * (1 - p / pages)) } : { kind: "epsilon", epsilon: 1 },
            mcSamples: 64, propensityFloor: 1e-6, maxShelves: 5, minCardsPerShelf: 2
        }, rng);
        latencies.push(page.elapsedMs);
        for (const placed of page.shelves) {
            const log = placed.cardLog;
            if (!log) continue;
            for (const card of placed.cards) {
                const { item, explanation } = lookup.get(card.candidate.actionId)!;
                const pTrue = env.rewardProbability(user, hour, item, explanation, card.slot);
                const r = rng.next() < pTrue ? 1 : 0;
                log.rewards[card.slot] = r;
                // the oracle: the best still-available card at this position, by true probability
                let best = 0;
                for (const a of remainingAt(log, card.slot)) {
                    const o = lookup.get(log.actionIds[a]!)!;
                    best = Math.max(best, env.rewardProbability(user, hour, o.item, o.explanation, card.slot));
                }
                oracle += best;
                reward += r;
                windowReward += r;
                shown++;
                windowShown++;
                if (learn) policies.card.update(cs.joint(policies.cardJoint, cardContext(base, placed.shelf.kind, card.slot), card.candidate.action), r);
            }
            if (logPath && name.startsWith("LinUCB")) logs.push(log);
        }
        if ((p + 1) % Math.max(1, Math.floor(pages / 10)) === 0) {
            curve.push(windowReward / Math.max(1, windowShown));
            windowReward = 0;
            windowShown = 0;
        }
    }
    latencies.sort((a, b) => a - b);
    const pct = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!.toFixed(1);
    console.log(`${name.padEnd(28)} engagement ${(reward / shown).toFixed(3)}   regret/card ${((oracle - reward) / shown).toFixed(3)}   page p50 ${pct(0.5)} ms p95 ${pct(0.95)} ms`);
    console.log(`${"".padEnd(28)} learning curve: ${curve.map((x) => x.toFixed(3)).join(" ")}`);
    if (logPath && logs.length) {
        writeFileSync(logPath, logs.map((l) => JSON.stringify({ ...l, context: Array.from(l.context), actions: l.actions.map((a) => Array.from(a)) })).join("\n") + "\n");
        console.log(`${"".padEnd(28)} ${logs.length} card decisions logged to ${logPath}`);
    }
}
