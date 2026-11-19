// Listening-mode discovery: one user's listening history clustered into the distinct "modes" they listen in
// (late-night ambient, 90s hip-hop, upbeat French pop...), each of which becomes a mix.
//
// 1. Engagement -> affinity. Streams (weighted by how much was heard), saves and playlist adds count for a
//    track; early skips count against it; everything decays with a half-life so recent listening dominates.
// 2. Each liked track becomes one vector of weighted, individually normalized blocks:
//      audio (z-scored descriptors + timbre) | collaborative factors | co-occurrence embedding |
//      text (genres, playlist titles, lyrics) | decade | when the user plays it (night/morning/...)
//    A block the track lacks is zero, so it simply does not pull.
// 3. Weighted spherical k-means++ (cosine), several restarts, for every k the history can support; the
//    number of modes is the largest k whose weighted silhouette is within 10 % of the best one - as many
//    mixes as the listening genuinely separates into, up to the configured maximum (6-10).
// 4. Modes too small (share of the weighted listening, or track count) merge into their nearest neighbour.
// 5. Each mode is named by its most distinctive facet: genre, mood, decade or time of day, the one most
//    over-represented compared to the user's listening as a whole; else by its artists.
import { Rng, cosine, normalized } from "../math";
import type { AudioFeatures } from "./audio";
import { TIMBRE_DIM } from "./audio";
import {
    type Engagement, type LabelKind, type MixLabel, type TimeBin, type TrackInfo, TIME_BINS, decadeOf, moodOf, timeBin
} from "./types";

export interface ModeConfig {
    minMixes: number,
    maxMixes: number,
    minTracksPerMode: number,
    minModeShare: number,
    restarts: number,
    recencyHalfLifeDays: number,
    seed: number
}

export interface TrackAffinity {
    positive: number,
    negative: number,
    /** decayed engagement per time-of-day bin */
    hours: number[],
    lastAt: number,
    plays: number
}

const DAY = 86_400_000;

/** one engagement's weight before decay; negative for an early skip */
export function engagementWeight(e: Engagement, durationMs: number | null): number {
    switch (e.kind) {
        case "save": return 3;
        case "playlist_add": return 2.5;
        case "skip": return -0.75 * Math.max(0, 1 - (e.msPlayed ?? 0) / 30_000);
        case "stream": {
            const ms = e.msPlayed ?? 0;
            if (ms < 30_000) return -0.75 * Math.max(0, 1 - ms / 30_000);
            const heard = durationMs && durationMs > 0 ? Math.min(1, ms / durationMs) : 0.6;
            return 0.25 + heard;
        }
    }
}

export function computeAffinities(events: readonly Engagement[], durations: ReadonlyMap<string, number | null>, now: number, halfLifeDays: number): Map<string, TrackAffinity> {
    const out = new Map<string, TrackAffinity>();
    for (const e of events) {
        const ageDays = Math.max(0, (now - e.at) / DAY);
        const decay = Math.pow(0.5, ageDays / Math.max(1e-6, halfLifeDays));
        const w = engagementWeight(e, durations.get(e.trackKey) ?? null) * decay;
        let a = out.get(e.trackKey);
        if (!a) out.set(e.trackKey, (a = { positive: 0, negative: 0, hours: [0, 0, 0, 0], lastAt: 0, plays: 0 }));
        if (w >= 0) a.positive += w;
        else a.negative -= w;
        if (e.localHour !== undefined && w > 0) a.hours[TIME_BINS.indexOf(timeBin(e.localHour))]! += w;
        if (e.kind === "stream" && (e.msPlayed ?? 0) >= 30_000) a.plays++;
        a.lastAt = Math.max(a.lastAt, e.at);
    }
    return out;
}

// ---------------------------------------------------------------- track vectors

export interface BlockWeights {
    audio: number,
    collaborative: number,
    embedding: number,
    text: number,
    decade: number,
    time: number
}

export const DEFAULT_BLOCK_WEIGHTS: BlockWeights = { audio: 0.3, collaborative: 0.15, embedding: 0.2, text: 0.2, decade: 0.1, time: 0.05 };

const DECADES = ["1950s", "1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];

export interface AudioStats {
    mean: number[],
    std: number[]
}

/** the scalar descriptors that are z-scored (tempo on a log scale), then the timbre coefficients */
export function audioVector(a: AudioFeatures): number[] {
    return [Math.log(Math.max(40, a.tempo)), a.energy, a.valence, a.danceability, a.acousticness, a.brightness, a.loudness / 10, a.mode, ...a.timbre.slice(0, TIMBRE_DIM)];
}

export function computeAudioStats(all: readonly AudioFeatures[]): AudioStats | null {
    if (all.length < 2) return null;
    const vs = all.map(audioVector);
    const d = vs[0]!.length;
    const mean = Array.from({ length: d }, (_, j) => vs.reduce((s, v) => s + v[j]!, 0) / vs.length);
    const std = Array.from({ length: d }, (_, j) => Math.sqrt(vs.reduce((s, v) => s + (v[j]! - mean[j]!) ** 2, 0) / vs.length) || 1);
    return { mean, std };
}

export function zAudio(a: AudioFeatures, stats: AudioStats): number[] {
    return audioVector(a).map((x, j) => (x - stats.mean[j]!) / stats.std[j]!);
}

export interface TrackSignals {
    info: TrackInfo,
    cf: Float64Array | null,
    embedding: Float64Array | null,
    text: Float64Array | null
}

/** fixed block lengths: every track vector of one user has the same layout, whatever the track lacks */
export interface SignalDims {
    cf: number,
    embedding: number,
    text: number
}

export function trackVector(t: TrackSignals, hours: readonly number[] | null, stats: AudioStats | null, w: BlockWeights, dims: SignalDims): Float64Array {
    const block = (v: ArrayLike<number> | null, weight: number): number[] => {
        if (!v || v.length === 0) return [];
        const n = normalized(v);
        return Array.from(n, (x) => x * Math.sqrt(weight));
    };
    const pad = (v: number[], len: number) => (v.length ? v : new Array(len).fill(0));
    const audio = t.info.audio && stats ? zAudio(t.info.audio, stats) : null;
    const decade = decadeOf(t.info.releaseYear);
    const decadeHot = decade ? DECADES.map((d) => (d === decade ? 1 : 0)) : null;
    return Float64Array.from([
        ...pad(block(audio, w.audio), 8 + TIMBRE_DIM),
        ...pad(block(t.cf, w.collaborative), dims.cf),
        ...pad(block(t.embedding, w.embedding), dims.embedding),
        ...pad(block(t.text, w.text), dims.text),
        ...pad(block(decadeHot, w.decade), DECADES.length),
        ...pad(block(hours && hours.some((h) => h > 0) ? hours : null, w.time), TIME_BINS.length)
    ]);
}

// ---------------------------------------------------------------- clustering

export interface Clustering {
    k: number,
    assignment: number[],
    centroids: Float64Array[],
    inertia: number
}

/** weighted spherical k-means with k-means++ seeding (cosine similarity, unit-norm centroids) */
export function sphericalKMeans(points: readonly Float64Array[], weights: readonly number[], k: number, rng: Rng, iterations = 50): Clustering {
    const n = points.length;
    const unit = points.map((p) => normalized(p));
    const centroids: Float64Array[] = [];
    centroids.push(Float64Array.from(unit[rng.categorical(weights)]!));
    while (centroids.length < k) {
        const d2 = unit.map((p, i) => {
            let best = Infinity;
            for (const c of centroids) best = Math.min(best, 1 - cosine(p, c));
            return Math.max(0, best) * weights[i]!;
        });
        centroids.push(Float64Array.from(unit[rng.categorical(d2)]!));
    }
    const assignment = new Array<number>(n).fill(0);
    let inertia = Infinity;
    for (let it = 0; it < iterations; it++) {
        let changed = false;
        inertia = 0;
        for (let i = 0; i < n; i++) {
            let best = 0;
            let bestSim = -Infinity;
            for (let c = 0; c < k; c++) {
                const s = cosine(unit[i]!, centroids[c]!);
                if (s > bestSim) {
                    bestSim = s;
                    best = c;
                }
            }
            if (assignment[i] !== best) changed = true;
            assignment[i] = best;
            inertia += weights[i]! * (1 - bestSim);
        }
        for (let c = 0; c < k; c++) {
            const sum = new Float64Array(unit[0]!.length);
            let any = false;
            for (let i = 0; i < n; i++) {
                if (assignment[i] !== c) continue;
                any = true;
                for (let j = 0; j < sum.length; j++) sum[j]! += weights[i]! * unit[i]![j]!;
            }
            // an empty cluster is re-seeded at the point worst served by its centroid
            if (!any) {
                let worst = 0;
                let worstSim = Infinity;
                for (let i = 0; i < n; i++) {
                    const s = cosine(unit[i]!, centroids[assignment[i]!]!);
                    if (s < worstSim) {
                        worstSim = s;
                        worst = i;
                    }
                }
                centroids[c] = Float64Array.from(unit[worst]!);
                assignment[worst] = c;
                changed = true;
                continue;
            }
            centroids[c] = normalized(sum);
        }
        if (!changed && it > 0) break;
    }
    return { k, assignment, centroids, inertia };
}

/** mean weighted silhouette with cosine distance */
export function weightedSilhouette(points: readonly Float64Array[], weights: readonly number[], assignment: readonly number[], k: number): number {
    if (k < 2) return 0;
    const n = points.length;
    let total = 0;
    let wsum = 0;
    for (let i = 0; i < n; i++) {
        const dist = new Float64Array(k);
        const wc = new Float64Array(k);
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            dist[assignment[j]!]! += weights[j]! * (1 - cosine(points[i]!, points[j]!));
            wc[assignment[j]!]! += weights[j]!;
        }
        const own = assignment[i]!;
        if (wc[own] === 0) continue; // singleton: silhouette 0 by convention
        const a = dist[own]! / wc[own]!;
        let b = Infinity;
        for (let c = 0; c < k; c++) if (c !== own && wc[c]! > 0) b = Math.min(b, dist[c]! / wc[c]!);
        if (!Number.isFinite(b)) continue;
        const s = (b - a) / Math.max(a, b, 1e-12);
        total += weights[i]! * s;
        wsum += weights[i]!;
    }
    return wsum > 0 ? total / wsum : 0;
}

// ---------------------------------------------------------------- modes

export interface ListeningMode {
    members: { key: string, weight: number }[],
    centroid: Float64Array,
    share: number,
    label: MixLabel,
    topArtists: { key: string, name: string, weight: number }[],
    /** the mode's weighted facet distributions, for the candidate gates and descriptions */
    facets: Record<"genre" | "decade" | "mood" | "time", Map<string, number>>
}

export interface ModeInput {
    tracks: ReadonlyMap<string, TrackSignals>,
    affinities: ReadonlyMap<string, TrackAffinity>,
    audioStats: AudioStats | null,
    dims: SignalDims,
    blockWeights?: BlockWeights
}

const MAX_SILHOUETTE_POINTS = 400;

export function discoverModes(input: ModeInput, cfg: ModeConfig): ListeningMode[] {
    const keys: string[] = [];
    const weights: number[] = [];
    for (const [key, a] of input.affinities) {
        const net = a.positive - a.negative;
        if (net <= 0.05 || !input.tracks.has(key)) continue;
        keys.push(key);
        weights.push(net);
    }
    if (keys.length < 3) return [];
    const w = input.blockWeights ?? DEFAULT_BLOCK_WEIGHTS;
    const points = keys.map((k) => trackVector(input.tracks.get(k)!, input.affinities.get(k)!.hours, input.audioStats, w, input.dims));
    const rng = new Rng(cfg.seed);

    const kMax = Math.max(1, Math.min(cfg.maxMixes, Math.floor(keys.length / cfg.minTracksPerMode)));
    const kMin = Math.min(Math.max(1, cfg.minMixes), kMax);

    // silhouette on the heaviest points only - O(n^2), and the light tail barely moves it
    const sample = keys.map((_, i) => i).sort((a, b) => weights[b]! - weights[a]!).slice(0, MAX_SILHOUETTE_POINTS);
    const candidates: { clustering: Clustering, silhouette: number }[] = [];
    for (let k = kMin; k <= kMax; k++) {
        let best: Clustering | null = null;
        for (let r = 0; r < cfg.restarts; r++) {
            const c = sphericalKMeans(points, weights, k, rng);
            if (!best || c.inertia < best.inertia) best = c;
        }
        const sil = k < 2 ? 0 : weightedSilhouette(sample.map((i) => points[i]!), sample.map((i) => weights[i]!), sample.map((i) => best!.assignment[i]!), k);
        candidates.push({ clustering: best!, silhouette: sil });
    }
    const bestSil = Math.max(...candidates.map((c) => c.silhouette));
    const chosen = bestSil <= 0
        ? candidates[0]!
        : [...candidates].reverse().find((c) => c.silhouette >= 0.9 * bestSil)!;

    let groups = groupBy(chosen.clustering.assignment, chosen.clustering.k);
    groups = mergeSmall(groups, points, weights, cfg);

    const total = weights.reduce((s, x) => s + x, 0);
    const overall = facetDistributions(keys.map((k, i) => ({ key: k, weight: weights[i]! })), input);
    const modes: ListeningMode[] = groups.map((idx) => {
        const members = idx.map((i) => ({ key: keys[i]!, weight: weights[i]! })).sort((a, b) => b.weight - a.weight);
        const centroid = new Float64Array(points[0]!.length);
        for (const i of idx) for (let j = 0; j < centroid.length; j++) centroid[j]! += weights[i]! * points[i]![j]!;
        const facets = facetDistributions(members, input);
        return {
            members,
            centroid: normalized(centroid),
            share: members.reduce((s, m) => s + m.weight, 0) / total,
            label: { kind: "artist", value: "" } as MixLabel,
            topArtists: topArtists(members, input),
            facets
        };
    }).sort((a, b) => b.share - a.share);

    labelModes(modes, overall);
    return modes;
}

function groupBy(assignment: readonly number[], k: number): number[][] {
    const groups: number[][] = Array.from({ length: k }, () => []);
    assignment.forEach((c, i) => groups[c]!.push(i));
    return groups.filter((g) => g.length > 0);
}

function mergeSmall(groups: number[][], points: readonly Float64Array[], weights: readonly number[], cfg: ModeConfig): number[][] {
    const total = weights.reduce((s, x) => s + x, 0);
    const share = (g: number[]) => g.reduce((s, i) => s + weights[i]!, 0) / total;
    const centroid = (g: number[]) => {
        const c = new Float64Array(points[0]!.length);
        for (const i of g) for (let j = 0; j < c.length; j++) c[j]! += weights[i]! * points[i]![j]!;
        return c;
    };
    const out = groups.map((g) => [...g]);
    for (;;) {
        if (out.length <= 1) break;
        let smallest = -1;
        for (let g = 0; g < out.length; g++) {
            const small = share(out[g]!) < cfg.minModeShare || out[g]!.length < cfg.minTracksPerMode;
            if (small && (smallest < 0 || share(out[g]!) < share(out[smallest]!))) smallest = g;
        }
        if (smallest < 0) break;
        const c = centroid(out[smallest]!);
        let target = -1;
        let bestSim = -Infinity;
        for (let g = 0; g < out.length; g++) {
            if (g === smallest) continue;
            const s = cosine(c, centroid(out[g]!));
            if (s > bestSim) {
                bestSim = s;
                target = g;
            }
        }
        out[target]!.push(...out[smallest]!);
        out.splice(smallest, 1);
    }
    return out;
}

function facetDistributions(members: readonly { key: string, weight: number }[], input: ModeInput): ListeningMode["facets"] {
    const facets = { genre: new Map<string, number>(), decade: new Map<string, number>(), mood: new Map<string, number>(), time: new Map<string, number>() };
    const totals = { genre: 0, decade: 0, mood: 0, time: 0 };
    const add = (f: keyof typeof facets, v: string | null | undefined, w: number) => {
        if (!v || !(w > 0)) return;
        facets[f].set(v, (facets[f].get(v) ?? 0) + w);
        totals[f] += w;
    };
    for (const m of members) {
        const t = input.tracks.get(m.key)!.info;
        add("genre", t.genres[0], m.weight);
        add("decade", decadeOf(t.releaseYear), m.weight);
        add("mood", moodOf(t.audio, t.tagMood ?? null), m.weight);
        const hours = input.affinities.get(m.key)?.hours;
        if (hours) {
            const hs = hours.reduce((s, x) => s + x, 0);
            if (hs > 0) hours.forEach((h, b) => add("time", TIME_BINS[b], (m.weight * h) / hs));
        }
    }
    for (const f of Object.keys(facets) as (keyof typeof facets)[]) {
        for (const [v, x] of facets[f]) facets[f].set(v, x / totals[f]);
    }
    return facets;
}

function topArtists(members: readonly { key: string, weight: number }[], input: ModeInput): ListeningMode["topArtists"] {
    const byArtist = new Map<string, { name: string, weight: number }>();
    for (const m of members) {
        const t = input.tracks.get(m.key)!.info;
        const a = byArtist.get(t.artistKey) ?? { name: t.artists[0] ?? "", weight: 0 };
        a.weight += m.weight;
        byArtist.set(t.artistKey, a);
    }
    return [...byArtist.entries()].map(([key, a]) => ({ key, ...a })).sort((a, b) => b.weight - a.weight).slice(0, 5);
}

const PURITY: Record<Exclude<LabelKind, "artist">, number> = { genre: 0.5, mood: 0.55, decade: 0.55, time: 0.6 };
const FACET_ORDER: Exclude<LabelKind, "artist">[] = ["genre", "mood", "decade", "time"];

function bestFacets(mode: ListeningMode, overall: ListeningMode["facets"]): { kind: Exclude<LabelKind, "artist">, value: string, distinct: number }[] {
    const out: { kind: Exclude<LabelKind, "artist">, value: string, distinct: number }[] = [];
    for (const kind of FACET_ORDER) {
        for (const [value, share] of mode.facets[kind]) {
            if (share < PURITY[kind]) continue;
            out.push({ kind, value, distinct: share - (overall[kind].get(value) ?? 0) * 0.5 });
        }
    }
    // most distinctive first; facet order breaks ties
    return out.sort((a, b) => (b.distinct - a.distinct) || (FACET_ORDER.indexOf(a.kind) - FACET_ORDER.indexOf(b.kind)));
}

function artistLabel(mode: ListeningMode): MixLabel {
    return { kind: "artist", value: mode.topArtists.slice(0, 2).map((a) => a.name).filter(Boolean).join(", ") };
}

/** names every mode; two modes never get the same name */
export function labelModes(modes: ListeningMode[], overall: ListeningMode["facets"]): void {
    const used = new Set<string>();
    const keyOf = (l: MixLabel) => `${l.kind}:${l.value}|${l.qualifier?.kind ?? ""}:${l.qualifier?.value ?? ""}`;
    for (const mode of modes) {
        const options = bestFacets(mode, overall);
        let label: MixLabel = options[0] ? { kind: options[0].kind, value: options[0].value } : artistLabel(mode);
        if (used.has(keyOf(label))) {
            // same main facet as an earlier (bigger) mode: qualify it with this mode's next facet of another kind
            const second = options.find((o) => o.kind !== label.kind);
            label = second
                ? { ...label, qualifier: { kind: second.kind, value: second.value } }
                : { ...label, qualifier: { kind: "artist", value: mode.topArtists[0]?.name ?? "" } };
        }
        if (used.has(keyOf(label))) label = artistLabel(mode);
        used.add(keyOf(label));
        mode.label = label;
    }
}

export function isTimeBin(v: string): v is TimeBin {
    return (TIME_BINS as readonly string[]).includes(v);
}
