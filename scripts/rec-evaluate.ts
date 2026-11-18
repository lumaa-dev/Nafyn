// bun run rec:evaluate [--pages N] [--seed S]
//
// Offline (counterfactual) evaluation, demonstrated where the truth is known: a logging policy serves a
// synthetic For You page with epsilon-greedy exploration and logs every decision with its propensities; then
// several candidate policies are evaluated on those logs only - IPS, clipped IPS, SNIPS, DM and doubly robust
// (cross-fitted reward model) - and compared with their TRUE value, computed from the environment's known
// reward probabilities on the very same logged contexts. Finally each candidate goes through the safe-update
// gate that decides, in production, whether it may replace the serving policy.
//
// On a live instance the same pipeline runs once a day on real logs (server/core/recOffline.ts); its reports
// are listed by GET /api/v1/recommendations/models (ADMIN).
import { Rng } from "../server/utils/recommender/math";
import { LinUcbPolicy } from "../server/utils/recommender/bandit/linucb";
import { createNeuralBandit } from "../server/utils/recommender/bandit/neuralTs";
import { cardContext, cardFeatureSpace, encodeContext, shelfFeatureSpace } from "../server/utils/recommender/bandit/features";
import { type PolicyBundle, rankPage } from "../server/utils/recommender/bandit/hierarchical";
import type { SlateLog } from "../server/utils/recommender/bandit/slate";
import type { BanditPolicy } from "../server/utils/recommender/bandit/score";
import { type TargetPolicy, banditAsTarget, crossFitRewardModel, evaluateTarget, expandSlates, gate } from "../server/utils/recommender/offline/evaluate";
import { generateBanditEnv } from "../server/utils/recommender/synthetic";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : fallback;
};
const pages = flag("--pages", 1200);
const seed = flag("--seed", 21);

const env = generateBanditEnv(seed, 50, 300);
const cs = cardFeatureSpace(16);
const ss = shelfFeatureSpace(8);
const shelfPolicy = () => new LinUcbPolicy(ss.linearDim, { ridge: 1, lambda: 0.3, refactorEvery: 500 });

function serve(card: BanditPolicy, n: number, rng: Rng, learn: boolean, epsilon: number) {
    const policies: PolicyBundle = { card, cardSpace: cs, cardJoint: card.kind === "linucb" ? "linear" : "neural", shelf: shelfPolicy(), shelfSpace: ss };
    const logs: SlateLog[] = [];
    const meta = new Map<SlateLog, { user: (typeof env.users)[number], hour: number, lookup: ReturnType<typeof env.page>["lookup"] }>();
    for (let p = 0; p < n; p++) {
        const user = rng.pick(env.users);
        const hour = rng.int(24);
        const base = encodeContext(env.context(user, hour));
        const { shelves, lookup } = env.page(user, hour, rng);
        const page = rankPage(base, shelves, policies, { exploration: { kind: "epsilon", epsilon }, mcSamples: 64, propensityFloor: 1e-6, maxShelves: 5, minCardsPerShelf: 2 }, rng);
        for (const placed of page.shelves) {
            if (!placed.cardLog) continue;
            for (const card of placed.cards) {
                const { item, explanation } = lookup.get(card.candidate.actionId)!;
                const r = rng.next() < env.rewardProbability(user, hour, item, explanation, card.slot) ? 1 : 0;
                placed.cardLog.rewards[card.slot] = r;
                if (learn) card && policies.card.update(cs.joint(policies.cardJoint, cardContext(base, placed.shelf.kind, card.slot), card.candidate.action), r);
            }
            logs.push(placed.cardLog);
            meta.set(placed.cardLog, { user, hour, lookup });
        }
    }
    return { logs, meta };
}

// the serving (logging) policy: a LinUCB trained on a little traffic, then frozen while it logs
const logging = new LinUcbPolicy(cs.linearDim, { ridge: 1, lambda: 0.5, refactorEvery: 500 });
serve(logging, 150, new Rng(seed), true, 0.2);
const { logs, meta } = serve(logging, pages, new Rng(seed + 1), false, 0.15);
const records = expandSlates(logs);
console.log(`${records.length} logged card decisions (${logs.length} slates) from ${pages} page views, logging policy epsilon = 0.15\n`);

// candidates, trained on separate traffic
function trained(card: BanditPolicy, n: number): BanditPolicy {
    serve(card, n, new Rng(seed + 99), true, 0.2);
    return card;
}
const candidates: TargetPolicy[] = [
    banditAsTarget("LinUCB, more traffic", trained(new LinUcbPolicy(cs.linearDim, { ridge: 1, lambda: 0.5, refactorEvery: 500 }), 1500), cs, "linear", { kind: "epsilon", epsilon: 0.05 }),
    banditAsTarget("Neural TS", trained(createNeuralBandit(cs.neuralDim, "mlp", { mode: "ts", ridge: 1, nu: 0.3, uncertainty: "last_layer", learningRate: 0.01, trainEvery: 50, trainSteps: 40, trainBatch: 64, replayCapacity: 20_000, hidden: [32, 16], fmRank: 8 }, new Rng(seed)), 800), cs, "neural", { kind: "epsilon", epsilon: 0.05 }, 128),
    banditAsTarget("untrained LinUCB", new LinUcbPolicy(cs.linearDim, { ridge: 1, lambda: 0, refactorEvery: 500 }), cs, "linear", { kind: "epsilon", epsilon: 0.05 }),
    banditAsTarget("logging policy itself", logging, cs, "linear", { kind: "epsilon", epsilon: 0.15 })
];

const q = crossFitRewardModel(records, { type: "fm", folds: 5, epochs: 8, hidden: [32], fmRank: 8, learningRate: 0.01, space: cs }, new Rng(seed + 3));

/** the true expected value of a policy on the logged positions, from the known reward probabilities */
function trueValue(target: TargetPolicy): number {
    let truth = 0;
    const r2 = new Rng(seed + 4);
    for (const r of records) {
        const log = logs[r.slate]!;
        const { user, hour, lookup } = meta.get(log)!;
        const probs = target.distribution(r.context, r.actions, r.available, r2);
        r.available.forEach((a, j) => {
            const o = lookup.get(log.actionIds[a]!)!;
            truth += probs[j]! * env.rewardProbability(user, hour, o.item, o.explanation, r.position);
        });
    }
    return truth / records.length;
}
const loggingTruth = trueValue(candidates[candidates.length - 1]!);

for (const target of candidates) {
    const report = evaluateTarget(records, target, q, { clip: 50, confidence: 0.95 }, new Rng(seed + 4));
    const truth = trueValue(target);
    const row = (e: typeof report.ips) => `${e.value.toFixed(4)} [${e.ciLow.toFixed(4)}, ${e.ciHigh.toFixed(4)}]`;
    const verdict = gate(report, { maxRegression: 0.005, minEss: 100, minDecisions: 500 });
    console.log(`== ${target.name}`);
    console.log(`   true value     ${truth.toFixed(4)}   (logging policy: true ${loggingTruth.toFixed(4)}, earned ${report.loggingPolicy.value.toFixed(4)})`);
    console.log(`   IPS            ${row(report.ips)}`);
    console.log(`   IPS clipped    ${row(report.ipsClipped)}   (${report.ipsClipped.clipped} weights clipped)`);
    console.log(`   SNIPS          ${row(report.snips)}`);
    console.log(`   DM             ${row(report.dm)}`);
    console.log(`   DR             ${row(report.dr)}   ESS ${report.dr.ess.toFixed(0)}`);
    console.log(`   DR - logging   ${row(report.improvement)}   (true ${(truth - loggingTruth).toFixed(4)})`);
    console.log(`   gate           ${verdict.accept ? "ACCEPT" : "reject"} - ${verdict.reason}\n`);
}
