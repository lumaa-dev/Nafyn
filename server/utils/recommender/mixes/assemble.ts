// From a listening mode and its scored candidates to an ordered mix: the familiar/novel balance, per-artist
// caps, the flow ordering, and the reason every track is there. Also keeps mix identities stable across
// refreshes, so "your 90s Hip-Hop Mix" stays the same mix as it evolves.
import { cosine } from "../math";
import type { Source, ScoredCandidate } from "./candidates";
import type { ListeningMode, TrackAffinity } from "./modes";
import { type SeqItem, type SequenceConfig, sequence } from "./sequencer";
import type { TrackInfo } from "./types";

export type TrackReason =
    | { kind: "familiar", plays: number, lastPlayedAt: number | null }
    | { kind: "novel", via: Source, seedArtist: string | null, fit: number };

export interface MixTrackPlan {
    key: string,
    position: number,
    familiar: boolean,
    /** familiar: how sure we are the user likes it. novel: the fused fit */
    confidence: number,
    reason: TrackReason
}

export interface AssembleConfig {
    mixLength: number,
    familiarRatio: number,
    maxTracksPerArtist: number,
    sequence: SequenceConfig
}

const DAY = 86_400_000;

export interface FamiliarCandidate {
    key: string,
    confidence: number,
    plays: number,
    lastPlayedAt: number | null
}

/** confidence that the user likes a member of the mode: saturating in engagement, nudged by recency */
export function familiarCandidates(mode: ListeningMode, affinities: ReadonlyMap<string, TrackAffinity>, now: number): FamiliarCandidate[] {
    const ws = mode.members.map((m) => m.weight).sort((a, b) => a - b);
    const median = ws[Math.floor(ws.length / 2)] || 1;
    return mode.members.map((m) => {
        const a = affinities.get(m.key);
        const saturation = 1 - Math.exp(-m.weight / median);
        const recency = a?.lastAt ? Math.exp(-(now - a.lastAt) / (90 * DAY)) : 0;
        return { key: m.key, confidence: 0.8 * saturation + 0.2 * recency, plays: a?.plays ?? 0, lastPlayedAt: a?.lastAt || null };
    }).sort((a, b) => b.confidence - a.confidence);
}

export function assembleMix(
    familiar: readonly FamiliarCandidate[],
    novel: readonly ScoredCandidate[],
    tracks: ReadonlyMap<string, TrackInfo>,
    cfg: AssembleConfig
): MixTrackPlan[] {
    const perArtist = new Map<string, number>();
    const take = (key: string): boolean => {
        const t = tracks.get(key);
        if (!t) return false;
        const n = perArtist.get(t.artistKey) ?? 0;
        if (n >= cfg.maxTracksPerArtist) return false;
        perArtist.set(t.artistKey, n + 1);
        return true;
    };

    // the familiar/novel split, each side topping up the other when it runs short
    const wantFamiliar = Math.round(cfg.mixLength * cfg.familiarRatio);
    const pickedFamiliar: FamiliarCandidate[] = [];
    for (const f of familiar) {
        if (pickedFamiliar.length >= wantFamiliar) break;
        if (take(f.key)) pickedFamiliar.push(f);
    }
    const pickedNovel: ScoredCandidate[] = [];
    for (const c of novel) {
        if (pickedFamiliar.length + pickedNovel.length >= cfg.mixLength) break;
        if (!tracks.has(c.evidence.track.key) || pickedNovel.some((p) => p.evidence.track.key === c.evidence.track.key)) continue;
        if (take(c.evidence.track.key)) pickedNovel.push(c);
    }
    for (const f of familiar) {
        if (pickedFamiliar.length + pickedNovel.length >= cfg.mixLength) break;
        if (pickedFamiliar.includes(f)) continue;
        if (take(f.key)) pickedFamiliar.push(f);
    }

    const items: SeqItem[] = [
        ...pickedFamiliar.map((f) => ({ key: f.key, artistKey: tracks.get(f.key)!.artistKey, familiar: true, audio: tracks.get(f.key)!.audio, score: f.confidence })),
        ...pickedNovel.map((c) => ({ key: c.evidence.track.key, artistKey: c.evidence.track.artistKey, familiar: false, audio: c.evidence.track.audio, score: c.fit }))
    ];
    const order = sequence(items, cfg.sequence);
    return order.map((i, position) => {
        const item = items[i]!;
        if (item.familiar) {
            const f = pickedFamiliar.find((x) => x.key === item.key)!;
            return { key: item.key, position, familiar: true, confidence: f.confidence, reason: { kind: "familiar", plays: f.plays, lastPlayedAt: f.lastPlayedAt } };
        }
        const c = pickedNovel.find((x) => x.evidence.track.key === item.key)!;
        return { key: item.key, position, familiar: false, confidence: c.fit, reason: { kind: "novel", via: c.dominant, seedArtist: c.evidence.seedArtist, fit: c.fit } };
    });
}

// ---------------------------------------------------------------- stable identities

/**
 * Optimal assignment (Hungarian algorithm, O(n^3)) minimizing cost[i][j] over a rectangular matrix
 * (rows <= cols is not required). Returns for each row the column it got, or -1.
 */
export function hungarian(cost: readonly (readonly number[])[]): number[] {
    const rows = cost.length;
    if (rows === 0) return [];
    const cols = cost[0]!.length;
    const n = Math.max(rows, cols);
    const big = 1e9;
    const a = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i > 0 && j > 0 && i <= rows && j <= cols ? cost[i - 1]![j - 1]! : i > 0 && j > 0 ? big / 1e3 : 0)));
    const u = new Array<number>(n + 1).fill(0);
    const v = new Array<number>(n + 1).fill(0);
    const p = new Array<number>(n + 1).fill(0);
    const way = new Array<number>(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Array<number>(n + 1).fill(Infinity);
        const used = new Array<boolean>(n + 1).fill(false);
        do {
            used[j0] = true;
            const i0 = p[j0]!;
            let delta = Infinity;
            let j1 = 0;
            for (let j = 1; j <= n; j++) {
                if (used[j]) continue;
                const cur = a[i0]![j]! - u[i0]! - v[j]!;
                if (cur < minv[j]!) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j]! < delta) {
                    delta = minv[j]!;
                    j1 = j;
                }
            }
            for (let j = 0; j <= n; j++) {
                if (used[j]) {
                    u[p[j]!]! += delta;
                    v[j]! -= delta;
                } else {
                    minv[j]! -= delta;
                }
            }
            j0 = j1;
        } while (p[j0] !== 0);
        do {
            const j1 = way[j0]!;
            p[j0] = p[j1]!;
            j0 = j1;
        } while (j0);
    }
    const result = new Array<number>(rows).fill(-1);
    for (let j = 1; j <= n; j++) {
        const i = p[j]!;
        if (i >= 1 && i <= rows && j <= cols) result[i - 1] = j - 1;
    }
    return result;
}

/**
 * For each new mode, the id of the previous mix it continues (best overall matching by centroid cosine,
 * kept only above `minSimilarity`), or null for a genuinely new mix.
 */
export function matchToPrevious(previous: readonly { id: string, centroid: Float64Array }[], next: readonly Float64Array[], minSimilarity = 0.5): (string | null)[] {
    if (previous.length === 0) return next.map(() => null);
    const sim = next.map((c) => previous.map((p) => (p.centroid.length === c.length ? cosine(c, p.centroid) : -1)));
    const assignment = hungarian(sim.map((row) => row.map((s) => 1 - s)));
    return assignment.map((j, i) => (j >= 0 && sim[i]![j]! >= minSimilarity ? previous[j]!.id : null));
}
