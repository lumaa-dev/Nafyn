// safe policy updates: a new ranking model only serves after it has been evaluated counterfactually on logged
// traffic and passed the gate.
//
// Once a day (and on demand from `bun run rec:evaluate --live`), per level (cards, shelves):
//   1. the finalized decisions of the last NAFYN_REC_EVALUATION_DAYS, oldest first, split by time: 70 % to
//      train a candidate of the configured kind from scratch, the newest 30 % to evaluate it on (a model is
//      never evaluated on the traffic it was trained on);
//   2. IPS, SNIPS, DM and DR (cross-fitted reward model) of the candidate as it would serve - its scores and
//      the configured exploration - against the logged propensities;
//   3. the gate: the candidate's DR lower bound must not fall below what the serving policy actually earned
//      on that same traffic (minus NAFYN_REC_GATE_MAX_REGRESSION), with enough decisions and effective sample
//      size. Accepted: it finishes training on the held-out part too and replaces the serving model.
//      Rejected: it is kept as a 'rejected' row with its report, and nothing changes for anyone.
// This is also how NAFYN_REC_POLICY switches from one kind of policy to another without a blind cut-over.
import { getLibrariesDb } from "./db";
import { getSetting, setSetting } from "./appSettings";
import {
    type ServingModel, cardSpace, createPolicy, explorationFor, getServingModels, jointKind, loadFinalizedLogs,
    replaceServingModel, serializePolicy, shelfSpace
} from "./recBandit";
import { getRecConfig } from "../utils/recConfig";
import { Rng } from "../utils/recommender/math";
import { NeuralBanditPolicy } from "../utils/recommender/bandit/neuralTs";
import type { BanditPolicy, PolicyKind } from "../utils/recommender/bandit/score";
import { type SlateLevel, type SlateLog, contextAt } from "../utils/recommender/bandit/slate";
import {
    type GateDecision, type OffPolicyReport, banditAsTarget, crossFitRewardModel, evaluateTarget, expandSlates, gate
} from "../utils/recommender/offline/evaluate";

const DAY = 86_400_000;
const LAST_RUN_KEY = "rec.lastEvaluationAt";

function train(policy: BanditPolicy, level: SlateLevel, kind: PolicyKind, logs: readonly SlateLog[]): void {
    const space = level === "card" ? cardSpace() : shelfSpace();
    const joint = level === "card" ? jointKind(kind) : "linear";
    for (const log of logs) {
        log.order.forEach((chosen, pos) => {
            const r = log.rewards[pos];
            if (r === null || r === undefined) return;
            policy.update(space.joint(joint, contextAt(log, pos), log.actions[chosen]!), r, log.confidences[pos] ?? 1);
        });
    }
    if (policy instanceof NeuralBanditPolicy) policy.train(policy.options.trainSteps * 3);
}

export interface LevelEvaluation {
    level: SlateLevel,
    kind: PolicyKind,
    status: "skipped" | "accepted" | "rejected",
    reason: string,
    report: OffPolicyReport | null,
    verdict: GateDecision | null
}

export async function evaluateLevel(level: SlateLevel, now = Date.now()): Promise<LevelEvaluation> {
    const c = getRecConfig();
    const kind: PolicyKind = level === "shelf" ? "linucb" : c.policy;
    const logs = await loadFinalizedLogs(level, now - c.evaluationDays * DAY);
    const decisions = logs.reduce((s, l) => s + l.order.length, 0);
    if (decisions < c.gateMinDecisions) {
        return { level, kind, status: "skipped", reason: `${decisions} logged decisions, the gate needs ${c.gateMinDecisions}`, report: null, verdict: null };
    }
    const split = Math.floor(logs.length * 0.7);
    const trainLogs = logs.slice(0, split);
    const testLogs = logs.slice(split);

    const candidate = createPolicy(level, kind, c.seed + 1);
    train(candidate, level, kind, trainLogs);
    const space = level === "card" ? cardSpace() : shelfSpace();
    const joint = level === "card" ? jointKind(kind) : "linear";
    const models = await getServingModels();
    // as it would serve: the exploration the serving model has decayed to by now
    const target = banditAsTarget(`${level}:${kind}`, candidate, space, joint, explorationFor((level === "card" ? models.card : models.shelf).served), c.tsPropensitySamples);
    const records = expandSlates(testLogs);
    const rng = new Rng(c.seed);
    const q = crossFitRewardModel(records, {
        type: c.rewardModel, folds: c.drFolds, epochs: 10, hidden: [32], fmRank: c.fmRank, learningRate: 0.01, space
    }, rng);
    const report = evaluateTarget(records, target, q, { clip: c.ipsClip, confidence: 0.95 }, rng);
    const verdict = gate(report, { maxRegression: c.gateMaxRegression, minEss: c.gateMinEss, minDecisions: Math.floor(c.gateMinDecisions * 0.3) });
    const metrics = JSON.stringify({ report, verdict, trainedOn: trainLogs.length, evaluatedOn: testLogs.length, at: now });
    const db = getLibrariesDb();

    if (!verdict.accept) {
        await db.prepare(`INSERT INTO rec_models (level, kind, status, state, served, metrics, created_at, updated_at) VALUES (?, ?, 'rejected', ?, 0, ?, ?, ?)`)
            .run(level, kind, serializePolicy(candidate), metrics, now, now);
        return { level, kind, status: "rejected", reason: verdict.reason, report, verdict };
    }

    // accepted: it learns from the held-out traffic too, then takes over
    train(candidate, level, kind, testLogs);
    const current: ServingModel = level === "card" ? models.card : models.shelf;
    const inserted = await db.prepare(`INSERT INTO rec_models (level, kind, status, state, served, metrics, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`)
        .run(level, kind, serializePolicy(candidate), current.served, metrics, now, now);
    await db.prepare(`UPDATE rec_models SET status = 'retired', updated_at = ? WHERE level = ? AND status = 'active' AND id <> ?`).run(now, level, inserted.lastInsertRowid);
    replaceServingModel({ id: inserted.lastInsertRowid, level, kind, policy: candidate, served: current.served, dirty: false });
    return { level, kind, status: "accepted", reason: verdict.reason, report, verdict };
}

/** the daily pass; returns null when it is not due yet */
export async function runDailyEvaluation(now = Date.now()): Promise<LevelEvaluation[] | null> {
    const last = Number(await getSetting(LAST_RUN_KEY) ?? 0);
    if (now - last < DAY) return null;
    await setSetting(LAST_RUN_KEY, String(now));
    const out: LevelEvaluation[] = [];
    for (const level of ["card", "shelf"] as const) {
        try {
            const result = await evaluateLevel(level, now);
            out.push(result);
            console.info(`[recommendations] offline evaluation (${level}, ${result.kind}): ${result.status} - ${result.reason}`);
        } catch (error) {
            console.error(`[recommendations] offline evaluation (${level}) failed:`, error);
        }
    }
    return out;
}

export interface ModelSummary {
    id: number,
    level: SlateLevel,
    kind: string,
    status: string,
    served: number,
    metrics: unknown,
    createdAt: number,
    updatedAt: number
}

export async function listModels(): Promise<ModelSummary[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT id, level, kind, status, served, metrics, created_at, updated_at FROM rec_models ORDER BY id DESC LIMIT 50
    `).all<{ id: number, level: SlateLevel, kind: string, status: string, served: number | string, metrics: unknown, created_at: number | string, updated_at: number | string }>();
    return rows.map((r) => ({
        id: r.id, level: r.level, kind: r.kind, status: r.status, served: Number(r.served),
        metrics: typeof r.metrics === "string" ? JSON.parse(r.metrics) : r.metrics,
        createdAt: Number(r.created_at), updatedAt: Number(r.updated_at)
    }));
}
