// the For You page: candidates, the contextual bandit that ranks them (shelves, then cards), the decision log,
// feedback, and the online updates once a decision's attribution window has closed.
//
// Online serving and offline evaluation are separate on purpose: this file only scores with the serving
// ("active") models, logs every decision with its propensities, and folds observed rewards into those models.
// Replacing a model with a differently trained one only happens through recOffline.ts, after the candidate
// has been evaluated counterfactually on logged traffic and passed the gate.
import { randomUUID } from "node:crypto";
import { getLibrariesDb, sqlInt } from "./db";
import { getAudioFeatures } from "./recAudio";
import { listMixes } from "./recMixes";
import { getRecConfig } from "../utils/recConfig";
import { Rng, base64ToF64, f64ToBase64, hashString } from "../utils/recommender/math";
import { audioSummary } from "../utils/recommender/mixes/audio";
import type { MixLabel } from "../utils/recommender/mixes/types";
import {
    type ActionInput, type Device, type ExplanationKind, type FeatureSpace, type ItemKind, type ShelfKind,
    ACTION_DIM, CONTEXT_DIM, SHELF_ACTION_DIM, cardContext, cardFeatureSpace, encodeAction, encodeContext, shelfContext, shelfFeatureSpace
} from "../utils/recommender/bandit/features";
import { type Explanation, type ExplainableItem, validExplanations } from "../utils/recommender/bandit/explanations";
import { type CardCandidate, type ShelfCandidate, rankPage } from "../utils/recommender/bandit/hierarchical";
import { type ExplorationSpec, epsilonAt } from "../utils/recommender/bandit/exploration";
import { type BanditPolicy, type PolicyKind } from "../utils/recommender/bandit/score";
import { LinUcbPolicy, type SerializedLinUcb } from "../utils/recommender/bandit/linucb";
import { NeuralBanditPolicy, type SerializedNeural, createNeuralBandit } from "../utils/recommender/bandit/neuralTs";
import { type FeedbackEvent, rewardFromEvents } from "../utils/recommender/bandit/reward";
import type { SlateLevel, SlateLog } from "../utils/recommender/bandit/slate";

const DAY = 86_400_000;
const RELOAD_CHECK_MS = 60_000;
const SHELF_INTERACTION_DIM = 8;

// ---------------------------------------------------------------- the serving models

export interface ServingModel {
    id: number,
    level: SlateLevel,
    kind: PolicyKind,
    policy: BanditPolicy,
    served: number,
    dirty: boolean
}

let serving: { card: ServingModel, shelf: ServingModel } | null = null;
let lastReloadCheck = 0;
let loading: Promise<{ card: ServingModel, shelf: ServingModel }> | null = null;

export function cardSpace(): FeatureSpace {
    return cardFeatureSpace(getRecConfig().interactionDim);
}

export function shelfSpace(): FeatureSpace {
    return shelfFeatureSpace(SHELF_INTERACTION_DIM);
}

export function jointKind(kind: PolicyKind): "linear" | "neural" {
    return kind === "linucb" ? "linear" : "neural";
}

export function createPolicy(level: SlateLevel, kind: PolicyKind, seed: number): BanditPolicy {
    const c = getRecConfig();
    const space = level === "card" ? cardSpace() : shelfSpace();
    if (kind === "linucb") return new LinUcbPolicy(space.linearDim, { ridge: c.ridge, lambda: c.lambda, refactorEvery: c.refactorEvery });
    return createNeuralBandit(space.neuralDim, c.neuralModel, {
        mode: kind === "neural_ts" ? "ts" : "ucb",
        ridge: c.ridge,
        nu: kind === "neural_ts" ? c.tsNu : c.lambda,
        uncertainty: c.neuralUncertainty,
        learningRate: c.learningRate,
        trainEvery: c.trainEvery,
        trainSteps: c.trainSteps,
        trainBatch: 64,
        replayCapacity: 20_000,
        hidden: c.hiddenSizes,
        fmRank: c.fmRank
    }, new Rng(seed));
}

export function serializePolicy(policy: BanditPolicy): string {
    if (policy instanceof LinUcbPolicy) return JSON.stringify(policy.serialize());
    if (policy instanceof NeuralBanditPolicy) return JSON.stringify(policy.serialize());
    throw new Error("unknown policy type");
}

export function deserializePolicy(state: string, seed: number): BanditPolicy {
    const parsed = JSON.parse(state) as SerializedLinUcb | SerializedNeural;
    if (parsed.kind === "linucb") return LinUcbPolicy.deserialize(parsed);
    return NeuralBanditPolicy.deserialize(parsed, new Rng(seed));
}

interface ModelRow {
    id: number,
    level: SlateLevel,
    kind: PolicyKind,
    state: string,
    served: number | string
}

async function loadLevel(level: SlateLevel): Promise<ServingModel> {
    const db = getLibrariesDb();
    const row = await db.prepare(`SELECT id, level, kind, state, served FROM rec_models WHERE level = ? AND status = 'active' ORDER BY id DESC LIMIT 1`).get<ModelRow>(level);
    if (row) {
        try {
            const policy = deserializePolicy(row.state, row.id);
            if (level === "card" && policy instanceof NeuralBanditPolicy) await rebuildReplay(policy);
            return { id: row.id, level, kind: row.kind, policy, served: Number(row.served), dirty: false };
        } catch (error) {
            // a model saved with another feature layout (an upgrade changed the dimensions) cannot serve: it is
            // retired and a fresh one starts, rather than the page failing for everyone
            console.warn(`[recommendations] the active ${level} model cannot be loaded, starting a fresh one:`, error);
            await db.prepare(`UPDATE rec_models SET status = 'retired', updated_at = ? WHERE id = ?`).run(Date.now(), row.id);
        }
    }
    // the shelf level is always LinUCB (a handful of arms, a linear model is the right tool); the card level
    // starts as configured. Later changes of NAFYN_REC_POLICY go through the offline gate (recOffline.ts).
    const kind: PolicyKind = level === "shelf" ? "linucb" : getRecConfig().policy;
    const policy = createPolicy(level, kind, getRecConfig().seed);
    const now = Date.now();
    const result = await db.prepare(`
        INSERT INTO rec_models (level, kind, status, state, served, metrics, created_at, updated_at) VALUES (?, ?, 'active', ?, 0, NULL, ?, ?)
    `).run(level, kind, serializePolicy(policy), now, now);
    return { id: result.lastInsertRowid, level, kind, policy, served: 0, dirty: false };
}

/** a neural policy's replay buffer is not stored with it: it is rebuilt from the latest finalized decisions */
async function rebuildReplay(policy: NeuralBanditPolicy): Promise<void> {
    const logs = await loadFinalizedLogs("card", Date.now() - 30 * DAY, 2000);
    const space = cardSpace();
    for (const log of logs) {
        log.order.forEach((chosen, pos) => {
            const r = log.rewards[pos];
            if (r === null || r === undefined) return;
            policy.remember(space.neural(cardContext(log.context, log.shelfKind!, pos), log.actions[chosen]!), r, log.confidences[pos] ?? 1);
        });
    }
}

export async function getServingModels(): Promise<{ card: ServingModel, shelf: ServingModel }> {
    if (serving && Date.now() - lastReloadCheck > RELOAD_CHECK_MS) {
        lastReloadCheck = Date.now();
        // another process (or the offline gate) promoted a model: serve that one
        const rows = await getLibrariesDb().prepare(`SELECT id, level FROM rec_models WHERE status = 'active'`).all<{ id: number, level: SlateLevel }>();
        const current = new Map(rows.map((r) => [r.level, r.id]));
        if (current.get("card") !== serving.card.id || current.get("shelf") !== serving.shelf.id) serving = null;
    }
    if (serving) return serving;
    loading ??= (async () => {
        const [card, shelf] = [await loadLevel("card"), await loadLevel("shelf")];
        serving = { card, shelf };
        lastReloadCheck = Date.now();
        return serving;
    })().finally(() => {
        loading = null;
    });
    return await loading;
}

/** swaps a freshly promoted model in (recOffline.ts) */
export function replaceServingModel(model: ServingModel): void {
    if (!serving) return;
    serving = { ...serving, [model.level]: model };
}

export async function persistServingModels(): Promise<void> {
    if (!serving) return;
    for (const m of [serving.card, serving.shelf]) {
        if (!m.dirty) continue;
        await getLibrariesDb().prepare(`UPDATE rec_models SET state = ?, served = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
            .run(serializePolicy(m.policy), m.served, Date.now(), m.id);
        m.dirty = false;
    }
}

export function explorationFor(served: number): ExplorationSpec {
    const c = getRecConfig();
    if (c.exploration === "softmax") return { kind: "softmax", temperature: c.softmaxTemperature };
    if (c.exploration === "none") return { kind: "none" };
    return { kind: "epsilon", epsilon: epsilonAt({ start: c.epsilonStart, end: c.epsilonEnd, decaySteps: c.epsilonDecaySteps }, served) };
}

// ---------------------------------------------------------------- page items

export interface CardItem {
    kind: ItemKind,
    refId: string,
    title: string,
    subtitle: string | null,
    coverArt: string | null,
    coverMediaId: string | null,
    playlistImage: string | null,
    /** mixes: up to four covers */
    covers?: string[],
    label?: MixLabel,
    href: string
}

interface Candidate {
    item: CardItem,
    explainable: ExplainableItem,
    action: Omit<ActionInput, "explanation">
}

export interface RequestContext {
    device: Device,
    tzOffsetMinutes: number,
    now: number
}

function meanAudio(features: ReturnType<typeof audioSummary>[]): number[] | null {
    if (features.length === 0) return null;
    return features[0]!.map((_, j) => features.reduce((s, f) => s + f[j]!, 0) / features.length);
}

function similarity(a: number[] | null, b: number[] | null): number {
    if (!a || !b) return 0;
    const d = Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]!) ** 2, 0) / a.length);
    return Math.max(0, 1 - 2 * d);
}

interface UserSignals {
    embedding: Float64Array | null,
    topArtists: Set<string>,
    recentAudio: number[] | null,
    playsLast30m: number,
    skipsLast30m: number,
    minutesSinceLastPlay: number | null,
    librarySize: number,
    lastPlayed: Map<string, number>
}

async function userSignals(userId: string, now: number): Promise<UserSignals> {
    const db = getLibrariesDb();
    const state = await db.prepare(`SELECT embedding, top_artists FROM rec_user_state WHERE user_id = ?`).get<{ embedding: string | null, top_artists: unknown }>(userId);
    const recent = await db.prepare(`SELECT type, refId, playedAt FROM recently_played WHERE userId = ? ORDER BY playedAt DESC LIMIT 200`)
        .all<{ type: string, refId: string, playedAt: number | string }>(userId);
    const lastPlayed = new Map(recent.map((r) => [`${r.type}:${r.refId}`, Number(r.playedAt)]));
    const recentTracks = recent.filter((r) => r.type === "track").slice(0, 5).map((r) => `media:${r.refId}`);
    const audio = await getAudioFeatures(recentTracks);
    const skips = await db.prepare(`
        SELECT COUNT(*) AS n FROM play_events WHERE user_id = :u AND duration_ms < 30000 AND started_at >= FROM_UNIXTIME(:from / 1000)
    `).get<{ n: number | string }>({ u: userId, from: now - 30 * 60_000 });
    const library = await db.prepare(`SELECT COUNT(*) AS n FROM library_entries WHERE userId = ?`).get<{ n: number | string }>(userId);
    const lastTrack = recent.find((r) => r.type === "track");
    const top = state?.top_artists ? ((typeof state.top_artists === "string" ? JSON.parse(state.top_artists) : state.top_artists) as string[]) : [];
    return {
        embedding: state?.embedding ? base64ToF64(state.embedding) : null,
        topArtists: new Set(top),
        recentAudio: meanAudio([...audio.values()].map(audioSummary)),
        playsLast30m: recent.filter((r) => r.type === "track" && now - Number(r.playedAt) < 30 * 60_000).length,
        skipsLast30m: Number(skips?.n ?? 0),
        minutesSinceLastPlay: lastTrack ? (now - Number(lastTrack.playedAt)) / 60_000 : null,
        librarySize: Number(library?.n ?? 0),
        lastPlayed
    };
}

async function mixCandidates(userId: string, signals: UserSignals): Promise<{ mixes: Candidate[], suggestions: Candidate[] }> {
    const db = getLibrariesDb();
    const mixes = await listMixes(userId);
    if (mixes.length === 0) return { mixes: [], suggestions: [] };
    const rows = await db.prepare(`
        SELECT t.mix_id, t.media_id, t.recording_id, t.familiar, t.confidence, t.reason, t.title, t.artist, t.album, t.cover_art, t.released_at
        FROM rec_mix_tracks t JOIN rec_mixes m ON m.id = t.mix_id WHERE m.user_id = ?
    `).all<{ mix_id: string, media_id: string | null, recording_id: string | null, familiar: number, confidence: number, reason: unknown, title: string, artist: string, album: string | null, cover_art: string | null, released_at: number | string | null }>(userId);
    const subjects = rows.map((r) => (r.familiar ? `media:${r.media_id}` : `rec:${r.recording_id}`));
    const audio = await getAudioFeatures(subjects);
    const owned = new Set((await db.prepare(`SELECT m.musicbrainzId FROM library_entries le JOIN media m ON m.id = le.mediaId WHERE le.userId = ?`).all<{ musicbrainzId: string }>(userId)).map((r) => r.musicbrainzId.toLowerCase()));
    const requested = new Set((await db.prepare(`SELECT musicbrainzId FROM requests WHERE requestedBy = ? AND status IN ('waiting', 'searching', 'downloading', 'processing', 'completed')`).all<{ musicbrainzId: string }>(userId)).map((r) => r.musicbrainzId.toLowerCase()));
    const mixTitle = new Map(mixes.map((m) => [m.id, m.title]));

    const mixCards: Candidate[] = mixes.map((m) => {
        const familiar = rows.filter((r) => r.mix_id === m.id && r.familiar);
        const a = meanAudio(familiar.map((r) => audio.get(`media:${r.media_id}`)).filter((x) => !!x).map((x) => audioSummary(x!)));
        return {
            item: { kind: "mix", refId: m.id, title: m.title, subtitle: m.topArtists.slice(0, 3).join(", ") || null, coverArt: m.covers[0] ?? null, coverMediaId: null, playlistImage: null, covers: m.covers, label: m.label, href: `/mix/${m.id}` },
            explainable: { kind: "mix", owned: true, releasedAt: null, lastPlayedAt: signals.lastPlayed.get(`mix:${m.id}`) ?? null, addedAt: m.refreshedAt, seedArtist: null, artists: m.topArtists, mixTitle: null, similarityToRecent: similarity(a, signals.recentAudio) },
            action: { kind: "mix", audio: a, affinity: Math.min(1, m.familiarCount / Math.max(1, m.trackCount)), fit: 1, popularity: 0.5, owned: true, releaseAgeDays: null, lastPlayedDays: null }
        };
    });

    const suggestions = rows
        .filter((r) => !r.familiar && r.recording_id && !owned.has(r.recording_id.toLowerCase()) && !requested.has(r.recording_id.toLowerCase()))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 40)
        .map((r): Candidate => {
            const reason = (typeof r.reason === "string" ? JSON.parse(r.reason) : r.reason) as { seedArtist?: string | null };
            const f = audio.get(`rec:${r.recording_id}`);
            const a = f ? audioSummary(f) : null;
            const releasedAt = r.released_at === null ? null : Number(r.released_at);
            const artists = r.artist.split(/,\s*| & | feat\. /i).filter(Boolean);
            return {
                item: { kind: "suggestion", refId: r.recording_id!, title: r.title, subtitle: r.artist, coverArt: r.cover_art, coverMediaId: null, playlistImage: null, href: `/t/${r.recording_id}` },
                explainable: { kind: "suggestion", owned: false, releasedAt, lastPlayedAt: null, addedAt: null, seedArtist: reason.seedArtist ?? null, artists, mixTitle: mixTitle.get(r.mix_id) ?? null, similarityToRecent: similarity(a, signals.recentAudio) },
                action: {
                    kind: "suggestion", audio: a, affinity: artists.some((x) => signals.topArtists.has(x.toLowerCase())) ? 1 : 0, fit: r.confidence, popularity: 0.5,
                    owned: false, releaseAgeDays: releasedAt ? (Date.now() - releasedAt) / DAY : null, lastPlayedDays: null
                }
            };
        });
    return { mixes: mixCards, suggestions };
}

async function libraryCandidates(userId: string, signals: UserSignals, now: number): Promise<{ jumpBackIn: Candidate[], rediscover: Candidate[], playlists: Candidate[] }> {
    const db = getLibrariesDb();
    const albums = await db.prepare(`
        SELECT media.albumId AS albumId, MIN(media.album) AS title, MIN(media.artistName) AS artist, MIN(media.coverArt) AS coverArt,
               MIN(CASE WHEN media.hasCustomCover = 1 THEN media.id END) AS coverMediaId, MIN(le.addedAt) AS addedAt,
               MIN(media.releaseDate) AS releaseDate, GROUP_CONCAT(media.id) AS mediaIds
        FROM library_entries le JOIN media ON media.id = le.mediaId
        WHERE le.userId = ? AND media.albumId IS NOT NULL AND media.albumId <> ''
        GROUP BY media.albumId
    `).all<{ albumId: string, title: string, artist: string, coverArt: string | null, coverMediaId: string | null, addedAt: number | string, releaseDate: number | string | null, mediaIds: string }>(userId);
    const audio = await getAudioFeatures(albums.flatMap((a) => a.mediaIds.split(",").slice(0, 3).map((id) => `media:${id}`)));

    const albumCandidate = (a: typeof albums[number]): Candidate => {
        const feats = a.mediaIds.split(",").slice(0, 3).map((id) => audio.get(`media:${id}`)).filter((x) => !!x).map((x) => audioSummary(x!));
        const ma = meanAudio(feats);
        const lastPlayedAt = signals.lastPlayed.get(`album:${a.albumId}`) ?? null;
        const releasedAt = a.releaseDate ? Number(a.releaseDate) : null;
        return {
            item: { kind: "album", refId: a.albumId, title: a.title, subtitle: a.artist, coverArt: a.coverArt, coverMediaId: a.coverMediaId, playlistImage: null, href: `/l/a/${a.albumId}` },
            explainable: { kind: "album", owned: true, releasedAt, lastPlayedAt, addedAt: Number(a.addedAt), seedArtist: null, artists: [a.artist], mixTitle: null, similarityToRecent: similarity(ma, signals.recentAudio) },
            action: {
                kind: "album", audio: ma, affinity: signals.topArtists.has(a.artist.toLowerCase()) ? 1 : 0, fit: similarity(ma, signals.recentAudio), popularity: 0.5, owned: true,
                releaseAgeDays: releasedAt ? (now - releasedAt) / DAY : null, lastPlayedDays: lastPlayedAt ? (now - lastPlayedAt) / DAY : null
            }
        };
    };
    const recentCut = now - 14 * DAY;
    const jumpBackIn = albums.filter((a) => (signals.lastPlayed.get(`album:${a.albumId}`) ?? 0) >= recentCut)
        .sort((a, b) => (signals.lastPlayed.get(`album:${b.albumId}`) ?? 0) - (signals.lastPlayed.get(`album:${a.albumId}`) ?? 0))
        .slice(0, 15).map(albumCandidate);
    const rediscover = albums.filter((a) => (signals.lastPlayed.get(`album:${a.albumId}`) ?? Number(a.addedAt)) < now - 60 * DAY)
        .sort((a, b) => hashString(a.albumId + new Date(now).toISOString().slice(0, 10)) - hashString(b.albumId + new Date(now).toISOString().slice(0, 10)))
        .slice(0, 20).map(albumCandidate);

    const playlists = await db.prepare(`
        SELECT p.id, p.title, p.image, p.updatedAt, p.ownerId FROM playlists p
        LEFT JOIN playlist_members pm ON pm.playlistId = p.id AND pm.userId = :u
        WHERE p.ownerId = :u OR pm.id IS NOT NULL
        ORDER BY p.updatedAt DESC LIMIT 20
    `).all<{ id: string, title: string, image: string | null, updatedAt: number | string, ownerId: string }>({ u: userId });
    const playlistCards = playlists.map((p): Candidate => {
        const lastPlayedAt = signals.lastPlayed.get(`playlist:${p.id}`) ?? null;
        return {
            item: { kind: "playlist", refId: p.id, title: p.title, subtitle: null, coverArt: null, coverMediaId: null, playlistImage: p.image, href: `/l/playlist/${p.id}` },
            explainable: { kind: "playlist", owned: true, releasedAt: null, lastPlayedAt, addedAt: Number(p.updatedAt), seedArtist: null, artists: [], mixTitle: null, similarityToRecent: 0 },
            action: { kind: "playlist", audio: null, affinity: p.ownerId === userId ? 1 : 0.5, fit: 0.5, popularity: 0.5, owned: true, releaseAgeDays: null, lastPlayedDays: lastPlayedAt ? (now - lastPlayedAt) / DAY : null }
        };
    });
    return { jumpBackIn, rediscover, playlists: playlistCards };
}

function toCards(candidates: readonly Candidate[], ctx: { now: number, topArtists: ReadonlySet<string> }, items: Map<string, { item: CardItem, explanation: Explanation }>): CardCandidate[] {
    const cards: CardCandidate[] = [];
    for (const c of candidates) {
        const itemKey = `${c.item.kind}:${c.item.refId}`;
        for (const explanation of validExplanations(c.explainable, ctx)) {
            const actionId = `${itemKey}#${explanation.kind}`;
            items.set(actionId, { item: c.item, explanation });
            cards.push({ actionId, itemKey, action: encodeAction({ ...c.action, explanation: explanation.kind as ExplanationKind }), explanation });
        }
    }
    return cards;
}

// ---------------------------------------------------------------- the page

export interface HomeShelf {
    decisionId: string,
    kind: ShelfKind,
    row: number,
    cards: { slot: number, actionId: string, item: CardItem, explanation: Explanation }[]
}

export interface HomePage {
    personalized: true,
    pageId: string,
    shelves: HomeShelf[],
    elapsedMs: number
}

export async function buildHomePage(userId: string, req: RequestContext): Promise<HomePage> {
    const c = getRecConfig();
    const models = await getServingModels();
    const signals = await userSignals(userId, req.now);
    const local = new Date(req.now + req.tzOffsetMinutes * 60_000);
    const base = encodeContext({
        userEmbedding: signals.embedding,
        recentAudio: signals.recentAudio,
        hour: local.getUTCHours(),
        weekday: local.getUTCDay(),
        device: req.device,
        tzOffsetMinutes: req.tzOffsetMinutes,
        session: { playsLast30m: signals.playsLast30m, skipsLast30m: signals.skipsLast30m, minutesSinceLastPlay: signals.minutesSinceLastPlay },
        librarySize: signals.librarySize
    });

    const [{ mixes, suggestions }, { jumpBackIn, rediscover, playlists }] = await Promise.all([
        mixCandidates(userId, signals),
        libraryCandidates(userId, signals, req.now)
    ]);
    const ctx = { now: req.now, topArtists: signals.topArtists };
    const lookup = new Map<string, { item: CardItem, explanation: Explanation }>();
    const shelves: ShelfCandidate[] = [
        { id: "mixes", kind: "mixes" as const, cards: toCards(mixes, ctx, lookup), maxCards: c.cardsPerShelf },
        { id: "suggestions", kind: "suggestions" as const, cards: toCards(suggestions, ctx, lookup), maxCards: c.cardsPerShelf },
        { id: "jump_back_in", kind: "jump_back_in" as const, cards: toCards(jumpBackIn, ctx, lookup), maxCards: c.cardsPerShelf },
        { id: "rediscover", kind: "rediscover" as const, cards: toCards(rediscover, ctx, lookup), maxCards: c.cardsPerShelf },
        { id: "playlists", kind: "playlists" as const, cards: toCards(playlists, ctx, lookup), maxCards: c.cardsPerShelf }
    ];

    // a fresh stream per request: exploration must actually be random, and its probabilities are logged
    const rng = new Rng((hashString(userId) ^ Math.floor(Math.random() * 2 ** 31) ^ req.now) >>> 0);
    const page = rankPage(base, shelves, {
        card: models.card.policy, cardSpace: cardSpace(), cardJoint: jointKind(models.card.kind),
        shelf: models.shelf.policy, shelfSpace: shelfSpace()
    }, {
        exploration: explorationFor(models.card.served),
        mcSamples: c.tsPropensitySamples,
        propensityFloor: c.propensityFloor,
        maxShelves: c.maxShelves,
        minCardsPerShelf: 1
    }, rng);

    const pageId = randomUUID();
    const shelfDecisionId = randomUUID();
    await insertDecision(shelfDecisionId, pageId, userId, models.shelf, page.shelfLog, req.now);
    const out: HomeShelf[] = [];
    for (const placed of page.shelves) {
        if (!placed.cardLog) continue;
        const decisionId = randomUUID();
        await insertDecision(decisionId, pageId, userId, models.card, placed.cardLog, req.now, placed.cards.map((p) => ({ mean: p.mean, sigma: p.sigma, lambda: p.lambda })));
        out.push({
            decisionId,
            kind: placed.shelf.kind,
            row: placed.row,
            cards: placed.cards.map((p) => ({ slot: p.slot, actionId: p.candidate.actionId, ...lookup.get(p.candidate.actionId)! }))
        });
    }
    models.card.served++;
    models.shelf.served++;
    models.card.dirty = true;
    models.shelf.dirty = true;
    return { personalized: true, pageId, shelves: out, elapsedMs: page.elapsedMs };
}

// ---------------------------------------------------------------- the decision log

function packActions(actions: readonly Float64Array[], dim: number): string {
    const flat = new Float64Array(actions.length * dim);
    actions.forEach((a, i) => flat.set(a, i * dim));
    return f64ToBase64(flat);
}

function unpackActions(text: string, dim: number): Float64Array[] {
    const flat = base64ToF64(text);
    const out: Float64Array[] = [];
    for (let i = 0; i < flat.length; i += dim) out.push(flat.slice(i, i + dim));
    return out;
}

async function insertDecision(id: string, pageId: string, userId: string, model: ServingModel, log: SlateLog, now: number, scores: { mean: number, sigma: number, lambda: number }[] = []): Promise<void> {
    const dim = log.level === "card" ? ACTION_DIM : SHELF_ACTION_DIM;
    await getLibrariesDb().prepare(`
        INSERT INTO rec_decisions (id, page_id, user_id, level, shelf_kind, policy, policy_version, context, actions, action_dim,
                                   action_ids, item_keys, chosen, propensities, scores, rewards, confidences, created_at, finalized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
    `).run(id, pageId, userId, log.level, log.shelfKind, model.kind, model.id, f64ToBase64(log.context), packActions(log.actions, dim), dim,
        JSON.stringify(log.actionIds), JSON.stringify(log.itemKeys), JSON.stringify(log.order), JSON.stringify(log.propensities),
        JSON.stringify(scores), now);
}

interface DecisionRow {
    id: string,
    page_id: string,
    user_id: string,
    level: SlateLevel,
    shelf_kind: ShelfKind | null,
    policy: string,
    context: string,
    actions: string,
    action_dim: number,
    action_ids: unknown,
    item_keys: unknown,
    chosen: unknown,
    propensities: unknown,
    rewards: unknown,
    confidences: unknown,
    created_at: number | string
}

function json<T>(v: unknown): T {
    return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

export function rowToLog(r: DecisionRow): SlateLog {
    const order = json<number[]>(r.chosen);
    return {
        level: r.level,
        shelfKind: r.shelf_kind,
        context: base64ToF64(r.context),
        actions: unpackActions(r.actions, r.action_dim),
        actionIds: json<string[]>(r.action_ids),
        itemKeys: json<string[]>(r.item_keys),
        order,
        propensities: json<number[]>(r.propensities),
        rewards: r.rewards ? json<(number | null)[]>(r.rewards) : order.map(() => null),
        confidences: r.confidences ? json<number[]>(r.confidences) : order.map(() => 1)
    };
}

/** finalized decisions of one level since `fromMs`, oldest first (offline training / evaluation) */
export async function loadFinalizedLogs(level: SlateLevel, fromMs: number, limit = 200_000): Promise<SlateLog[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT * FROM rec_decisions WHERE level = ? AND finalized_at IS NOT NULL AND created_at >= ?
        ORDER BY created_at ASC LIMIT ${sqlInt(limit)}
    `).all<DecisionRow>(level, fromMs);
    // a decision logged with another feature layout (before an upgrade) cannot be replayed
    const dim = level === "card" ? ACTION_DIM : SHELF_ACTION_DIM;
    return rows.filter((r) => r.action_dim === dim && base64ToF64(r.context).length === CONTEXT_DIM).map(rowToLog);
}

// ---------------------------------------------------------------- feedback and finalization

export type FeedbackKind = FeedbackEvent["kind"];

export async function recordFeedback(userId: string, decisionId: string, slot: number, event: FeedbackKind, msPlayed: number): Promise<"recorded" | "missing" | "closed"> {
    const db = getLibrariesDb();
    const row = await db.prepare(`SELECT chosen, created_at, finalized_at, level FROM rec_decisions WHERE id = ? AND user_id = ?`)
        .get<{ chosen: unknown, created_at: number | string, finalized_at: number | string | null, level: string }>(decisionId, userId);
    if (!row || row.level !== "card") return "missing";
    const order = json<number[]>(row.chosen);
    if (!Number.isInteger(slot) || slot < 0 || slot >= order.length) return "missing";
    // after the window the reward is already written and learned from: late feedback changes nothing
    if (row.finalized_at !== null || Date.now() - Number(row.created_at) > getRecConfig().rewardWindowMinutes * 60_000) return "closed";
    await db.prepare(`INSERT INTO rec_feedback (decision_id, user_id, slot, event, ms_played, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(decisionId, userId, slot, event, Math.max(0, Math.min(2 ** 31 - 1, Math.round(msPlayed))), Date.now());
    return "recorded";
}

/**
 * Closes the attribution window of decisions older than it: computes each position's reward from its
 * feedback (none = shown and ignored = failure), writes it, and folds it into the serving models. Each
 * decision is claimed by a conditional UPDATE, so a decision is learned from once even with two schedulers.
 */
export async function finalizeDecisions(limit = 500): Promise<number> {
    const c = getRecConfig();
    const db = getLibrariesDb();
    const cutoff = Date.now() - c.rewardWindowMinutes * 60_000;
    const rows = await db.prepare(`
        SELECT * FROM rec_decisions WHERE finalized_at IS NULL AND created_at < ? ORDER BY created_at ASC LIMIT ${sqlInt(limit)}
    `).all<DecisionRow>(cutoff);
    if (rows.length === 0) return 0;
    const models = await getServingModels();
    const rewardCfg = { thresholdMs: c.rewardThresholdMs, graded: c.gradedReward, previewThresholdMs: Math.min(20_000, c.rewardThresholdMs) };
    const cs = cardSpace();
    const ss = shelfSpace();
    const cardRewardsByPage = new Map<string, Map<string, number>>();
    let done = 0;

    // cards first: a shelf's reward is the best reward among its cards
    for (const r of [...rows.filter((x) => x.level === "card"), ...rows.filter((x) => x.level === "shelf")]) {
        const log = rowToLog(r);
        if (r.level === "card") {
            const feedback = await db.prepare(`SELECT slot, event, ms_played FROM rec_feedback WHERE decision_id = ?`).all<{ slot: number, event: string, ms_played: number }>(r.id);
            const rewards: number[] = [];
            const confidences: number[] = [];
            log.order.forEach((_, slot) => {
                const events: FeedbackEvent[] = feedback.filter((f) => f.slot === slot).map((f) =>
                    f.event === "play" || f.event === "preview" ? { kind: f.event, msPlayed: f.ms_played } : { kind: f.event as "request" | "open" });
                const reward = rewardFromEvents(events, rewardCfg);
                rewards.push(reward.value);
                confidences.push(reward.confidence);
            });
            const claimed = await db.prepare(`UPDATE rec_decisions SET rewards = ?, confidences = ?, finalized_at = ? WHERE id = ? AND finalized_at IS NULL`)
                .run(JSON.stringify(rewards), JSON.stringify(confidences), Date.now(), r.id);
            if (claimed.changes !== 1) continue;
            const best = Math.max(0, ...rewards);
            const byShelf = cardRewardsByPage.get(r.page_id) ?? new Map<string, number>();
            byShelf.set(r.shelf_kind ?? "", best);
            cardRewardsByPage.set(r.page_id, byShelf);
            // only into a model with the same feature layout it was logged with
            if (r.action_dim === ACTION_DIM && log.context.length === CONTEXT_DIM) {
                const joint = jointKind(models.card.kind);
                log.order.forEach((chosen, slot) => {
                    models.card.policy.update(cs.joint(joint, cardContext(log.context, log.shelfKind!, slot), log.actions[chosen]!), rewards[slot]!, confidences[slot]!);
                });
                models.card.dirty = true;
            }
        } else {
            let byShelf = cardRewardsByPage.get(r.page_id);
            if (!byShelf) {
                // its card decisions were finalized in an earlier pass: read their rewards back
                const cards = await db.prepare(`SELECT shelf_kind, rewards FROM rec_decisions WHERE page_id = ? AND level = 'card'`).all<{ shelf_kind: string, rewards: unknown }>(r.page_id);
                byShelf = new Map(cards.map((x) => [x.shelf_kind, Math.max(0, ...(x.rewards ? json<(number | null)[]>(x.rewards).map((v) => v ?? 0) : [0]))]));
            }
            const rewards = log.order.map((chosen) => byShelf!.get(log.actionIds[chosen]!) ?? 0);
            const claimed = await db.prepare(`UPDATE rec_decisions SET rewards = ?, confidences = ?, finalized_at = ? WHERE id = ? AND finalized_at IS NULL`)
                .run(JSON.stringify(rewards), JSON.stringify(rewards.map(() => 1)), Date.now(), r.id);
            if (claimed.changes !== 1) continue;
            if (r.action_dim === SHELF_ACTION_DIM && log.context.length === CONTEXT_DIM) {
                log.order.forEach((chosen, row) => models.shelf.policy.update(ss.linear(shelfContext(log.context, row), log.actions[chosen]!), rewards[row]!));
                models.shelf.dirty = true;
            }
        }
        done++;
    }
    await persistServingModels();
    return done;
}

// ---------------------------------------------------------------- retention, erasure, export

export async function pruneDecisions(): Promise<number> {
    const cutoff = Date.now() - getRecConfig().decisionRetentionDays * DAY;
    const db = getLibrariesDb();
    await db.prepare(`DELETE f FROM rec_feedback f JOIN rec_decisions d ON d.id = f.decision_id WHERE d.created_at < ?`).run(cutoff);
    const result = await db.prepare(`DELETE FROM rec_decisions WHERE created_at < ? LIMIT ${sqlInt(50_000)}`).run(cutoff);
    // keep the serving models and the last 20 others (their metrics are the evaluation history)
    await db.prepare(`
        DELETE FROM rec_models WHERE status <> 'active' AND id NOT IN (
            SELECT id FROM (SELECT id FROM rec_models WHERE status <> 'active' ORDER BY id DESC LIMIT 20) kept
        )
    `).run();
    return result.changes;
}

/** for the export: what was shown, when, why, with what probability, and what came of it (no raw vectors) */
export async function listDecisionExportForUser(userId: string): Promise<unknown[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT id, page_id, level, shelf_kind, policy, action_ids, chosen, propensities, rewards, created_at, finalized_at
        FROM rec_decisions WHERE user_id = ? ORDER BY created_at ASC
    `).all<Record<string, unknown>>(userId);
    const feedback = await getLibrariesDb().prepare(`SELECT decision_id, slot, event, ms_played, created_at FROM rec_feedback WHERE user_id = ?`).all<Record<string, unknown>>(userId);
    return rows.map((r) => {
        const ids = json<string[]>(r.action_ids);
        return {
            id: r.id,
            pageId: r.page_id,
            level: r.level,
            shelf: r.shelf_kind,
            policy: r.policy,
            shown: json<number[]>(r.chosen).map((i) => ids[i]),
            propensities: json<number[]>(r.propensities),
            rewards: r.rewards ? json<unknown[]>(r.rewards) : null,
            createdAt: Number(r.created_at),
            finalizedAt: r.finalized_at === null ? null : Number(r.finalized_at),
            feedback: feedback.filter((f) => f.decision_id === r.id).map((f) => ({ slot: f.slot, event: f.event, msPlayed: f.ms_played, at: Number(f.created_at) }))
        };
    });
}
