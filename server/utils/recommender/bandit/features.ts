// Context s and action a as fixed-length vectors, and the joint feature x(s, a) each policy scores.
//
// Logs store the raw context vector and every candidate's action vector (never the joint one), so a policy
// with a different joint transform - LinUCB's crossed features, or the neural models' plain concatenation -
// can be trained and evaluated offline on the same logs.
//
//   linear joint:  [1, s, a, (P s) * (Q a)]  - P, Q fixed random projections (seeded, identical on every
//                  process and every restart), so the elementwise product carries context x action
//                  interactions into a linear model in O(k) extra dimensions instead of |s| * |a|
//   neural joint:  [s, a]                     - the MLP / factorization machine learn the interactions
import { Rng, clamp } from "../math";

export const USER_EMBEDDING_DIM = 8;
export const AUDIO_SUMMARY_DIM = 6; // energy, valence, tempo (scaled), danceability, acousticness, brightness

export const DEVICES = ["web", "ios", "android", "subsonic", "other"] as const;
export type Device = (typeof DEVICES)[number];

// Nafyn knows no location; the client's UTC offset is the only regional signal, bucketed coarsely on purpose
export const REGIONS = ["americas", "europe_africa", "asia_pacific"] as const;
export type Region = (typeof REGIONS)[number];

export const ITEM_KINDS = ["mix", "suggestion", "album", "playlist", "track"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const EXPLANATIONS = ["none", "because_artist", "from_mix", "new_release", "rediscover", "recently_played", "similar_to_recent"] as const;
export type ExplanationKind = (typeof EXPLANATIONS)[number];

export const SHELF_KINDS = ["mixes", "suggestions", "jump_back_in", "rediscover", "playlists"] as const;
export type ShelfKind = (typeof SHELF_KINDS)[number];

export interface SessionSignals {
    playsLast30m: number,
    skipsLast30m: number,
    minutesSinceLastPlay: number | null
}

export interface ContextInput {
    /** the user's collaborative-filtering factors, null for a cold-start user */
    userEmbedding: ArrayLike<number> | null,
    /** mean audio summary of the last plays, null when unknown */
    recentAudio: ArrayLike<number> | null,
    /** local hour 0-23 and weekday 0 (Sunday) - 6 */
    hour: number,
    weekday: number,
    device: Device,
    tzOffsetMinutes: number,
    session: SessionSignals,
    librarySize: number
}

export const CONTEXT_DIM = USER_EMBEDDING_DIM + 1 + AUDIO_SUMMARY_DIM + 1 + 5 + DEVICES.length + REGIONS.length + 3 + 1;

export function regionFromOffset(tzOffsetMinutes: number): Region {
    if (tzOffsetMinutes <= -180) return "americas";
    if (tzOffsetMinutes < 240) return "europe_africa";
    return "asia_pacific";
}

function oneHot<T>(values: readonly T[], value: T): number[] {
    return values.map((v) => (v === value ? 1 : 0));
}

function writeEmbedding(out: number[], v: ArrayLike<number> | null, dim: number): void {
    for (let i = 0; i < dim; i++) out.push(v && i < v.length && Number.isFinite(v[i]!) ? clamp(v[i]!, -3, 3) : 0);
    out.push(v ? 0 : 1); // "unknown" flag: cold start is a feature, not a zero vector pretending to be one
}

export function encodeContext(c: ContextInput): Float64Array {
    const out: number[] = [];
    writeEmbedding(out, c.userEmbedding, USER_EMBEDDING_DIM);
    writeEmbedding(out, c.recentAudio, AUDIO_SUMMARY_DIM);
    const h = (2 * Math.PI * c.hour) / 24;
    const d = (2 * Math.PI * c.weekday) / 7;
    out.push(Math.sin(h), Math.cos(h), Math.sin(d), Math.cos(d), c.weekday === 0 || c.weekday === 6 ? 1 : 0);
    out.push(...oneHot(DEVICES, c.device));
    out.push(...oneHot(REGIONS, regionFromOffset(c.tzOffsetMinutes)));
    out.push(
        Math.log1p(Math.max(0, c.session.playsLast30m)) / 3,
        c.session.playsLast30m > 0 ? c.session.skipsLast30m / c.session.playsLast30m : 0,
        c.session.minutesSinceLastPlay === null ? 1 : Math.min(1, Math.log1p(c.session.minutesSinceLastPlay) / Math.log1p(60 * 24 * 7))
    );
    out.push(Math.log1p(Math.max(0, c.librarySize)) / 10);
    if (out.length !== CONTEXT_DIM) throw new Error(`encodeContext: ${out.length} != ${CONTEXT_DIM}`);
    return Float64Array.from(out);
}

export interface ActionInput {
    kind: ItemKind,
    audio: ArrayLike<number> | null,
    /** 0..1: how much the user listens to this item's artist(s) */
    affinity: number,
    /** 0..1: fit with the user's taste (mode fit for suggestions, similarity otherwise) */
    fit: number,
    /** 0..1 */
    popularity: number,
    owned: boolean,
    releaseAgeDays: number | null,
    lastPlayedDays: number | null,
    explanation: ExplanationKind
}

export const ACTION_DIM = ITEM_KINDS.length + AUDIO_SUMMARY_DIM + 1 + 4 + 2 + 2 + EXPLANATIONS.length;

function logDays(days: number | null): [number, number] {
    if (days === null || !Number.isFinite(days)) return [0, 1];
    return [Math.min(1, Math.log1p(Math.max(0, days)) / Math.log1p(3650)), 0];
}

export function encodeAction(a: ActionInput): Float64Array {
    const out: number[] = [];
    out.push(...oneHot(ITEM_KINDS, a.kind));
    writeEmbedding(out, a.audio, AUDIO_SUMMARY_DIM);
    out.push(clamp(a.affinity, 0, 1), clamp(a.fit, 0, 1), clamp(a.popularity, 0, 1), a.owned ? 1 : 0);
    out.push(...logDays(a.releaseAgeDays), ...logDays(a.lastPlayedDays));
    out.push(...oneHot(EXPLANATIONS, a.explanation));
    if (out.length !== ACTION_DIM) throw new Error(`encodeAction: ${out.length} != ${ACTION_DIM}`);
    return Float64Array.from(out);
}

// ---- card and shelf decisions: the base context plus where the decision sits on the page

export const CARD_CONTEXT_DIM = CONTEXT_DIM + SHELF_KINDS.length + 2;
export const SHELF_CONTEXT_DIM = CONTEXT_DIM + 2;
export const SHELF_ACTION_DIM = SHELF_KINDS.length + 3;

function positionFeatures(position: number): number[] {
    return [Math.log1p(position) / Math.log1p(20), position === 0 ? 1 : 0];
}

export function cardContext(base: Float64Array, shelf: ShelfKind, position: number): Float64Array {
    return Float64Array.from([...base, ...oneHot(SHELF_KINDS, shelf), ...positionFeatures(position)]);
}

export function shelfContext(base: Float64Array, row: number): Float64Array {
    return Float64Array.from([...base, ...positionFeatures(row)]);
}

/** a shelf as an action: its kind and how good its best cards are predicted to be */
export function encodeShelf(kind: ShelfKind, cardMeans: ArrayLike<number>, cardCount: number): Float64Array {
    const sorted = Array.from(cardMeans).sort((a, b) => b - a);
    const top = sorted.slice(0, 3);
    const max = top.length ? clamp(top[0]!, -1, 2) : 0;
    const meanTop = top.length ? clamp(top.reduce((s, x) => s + x, 0) / top.length, -1, 2) : 0;
    return Float64Array.from([...oneHot(SHELF_KINDS, kind), max, meanTop, Math.log1p(cardCount) / Math.log1p(50)]);
}

// ---- joint features

export class FeatureSpace {
    readonly contextDim: number;
    readonly actionDim: number;
    readonly interactionDim: number;
    private readonly p: Float64Array; // interactionDim x contextDim
    private readonly q: Float64Array; // interactionDim x actionDim
    // Q a depends on the action only, and the same action vector is re-scored at every slot of a slate
    private readonly qaCache = new WeakMap<object, Float64Array>();

    constructor(contextDim: number, actionDim: number, interactionDim: number, seed: number) {
        this.contextDim = contextDim;
        this.actionDim = actionDim;
        this.interactionDim = interactionDim;
        const rng = new Rng(seed);
        this.p = Float64Array.from({ length: interactionDim * contextDim }, () => rng.normal() / Math.sqrt(contextDim));
        this.q = Float64Array.from({ length: interactionDim * actionDim }, () => rng.normal() / Math.sqrt(actionDim));
    }

    get linearDim(): number {
        return 1 + this.contextDim + this.actionDim + this.interactionDim;
    }

    get neuralDim(): number {
        return this.contextDim + this.actionDim;
    }

    linear(s: ArrayLike<number>, a: ArrayLike<number>): Float64Array {
        const out = new Float64Array(this.linearDim);
        out[0] = 1;
        for (let i = 0; i < this.contextDim; i++) out[1 + i] = s[i]!;
        for (let i = 0; i < this.actionDim; i++) out[1 + this.contextDim + i] = a[i]!;
        const base = 1 + this.contextDim + this.actionDim;
        const qa = this.projectAction(a);
        for (let k = 0; k < this.interactionDim; k++) {
            let ps = 0;
            for (let i = 0; i < this.contextDim; i++) ps += this.p[k * this.contextDim + i]! * s[i]!;
            out[base + k] = ps * qa[k]!;
        }
        return out;
    }

    private projectAction(a: ArrayLike<number>): Float64Array {
        const cacheable = typeof a === "object" && a !== null;
        const hit = cacheable ? this.qaCache.get(a as object) : undefined;
        if (hit) return hit;
        const qa = new Float64Array(this.interactionDim);
        for (let k = 0; k < this.interactionDim; k++) {
            let v = 0;
            for (let i = 0; i < this.actionDim; i++) v += this.q[k * this.actionDim + i]! * a[i]!;
            qa[k] = v;
        }
        if (cacheable) this.qaCache.set(a as object, qa);
        return qa;
    }

    neural(s: ArrayLike<number>, a: ArrayLike<number>): Float64Array {
        const out = new Float64Array(this.neuralDim);
        for (let i = 0; i < this.contextDim; i++) out[i] = s[i]!;
        for (let i = 0; i < this.actionDim; i++) out[this.contextDim + i] = a[i]!;
        return out;
    }

    joint(kind: "linear" | "neural", s: ArrayLike<number>, a: ArrayLike<number>): Float64Array {
        return kind === "linear" ? this.linear(s, a) : this.neural(s, a);
    }
}

// fixed seeds: the projections must be identical everywhere a model trained with them is used
export const CARD_FEATURE_SEED = 0x6361_7264; // "card"
export const SHELF_FEATURE_SEED = 0x7368_656c; // "shel"

export function cardFeatureSpace(interactionDim: number): FeatureSpace {
    return new FeatureSpace(CARD_CONTEXT_DIM, ACTION_DIM, interactionDim, CARD_FEATURE_SEED);
}

export function shelfFeatureSpace(interactionDim: number): FeatureSpace {
    return new FeatureSpace(SHELF_CONTEXT_DIM, SHELF_ACTION_DIM, interactionDim, SHELF_FEATURE_SEED);
}
