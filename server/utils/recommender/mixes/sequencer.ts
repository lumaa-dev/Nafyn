// Ordering a mix for listening flow.
//
// Cost of placing track j right after track i, at relative position p in the mix:
//   transition(i, j) = 0.5 * audio distance (energy, valence, danceability, brightness, acousticness)
//                    + 0.3 * harmonic distance on the Camelot wheel (DJ key compatibility)
//                    + 0.2 * tempo distance, octave-aware (128 BPM next to 64 BPM is half-time, not a clash)
//   arc(j, p)        = |energy_j - target(p)|, target being the mix's energy arc scaled to its own range
//   constraints      - the same artist within `artistSeparation` positions, or more than `maxNovelRun`
//                      unfamiliar tracks in a row, are penalized hard enough to never win
// Greedy nearest-neighbour construction from the best opening track, then 2-opt segment reversals while they
// lower the total cost.
import type { AudioFeatures } from "./audio";

export type EnergyArc = "arc" | "rise" | "wave" | "flat";

export interface SeqItem {
    key: string,
    artistKey: string,
    familiar: boolean,
    audio: AudioFeatures | null,
    /** confidence / fit, used to pick the opener */
    score: number
}

export interface SequenceConfig {
    arc: EnergyArc,
    artistSeparation: number,
    maxNovelRun: number,
    twoOptPasses: number
}

const HARD = 10;

/** Camelot wheel position (1-12) and letter (A minor, B major) of a key */
export function camelot(key: number, mode: number): { number: number, letter: "A" | "B" } {
    // major keys: C = 8B, one step clockwise per fifth; a minor key sits with its relative major (+3 semitones)
    const major = mode === 1 ? key : (key + 3) % 12;
    return { number: (((major * 7) % 12) + 7) % 12 + 1, letter: mode === 1 ? "B" : "A" };
}

/** 0 = same key, 1/3 = adjacent (one step, or relative major/minor), up to 1 */
export function harmonicDistance(a: AudioFeatures | null, b: AudioFeatures | null): number {
    if (!a || !b) return 0.5;
    const ca = camelot(a.key, a.mode);
    const cb = camelot(b.key, b.mode);
    const ring = Math.min(Math.abs(ca.number - cb.number), 12 - Math.abs(ca.number - cb.number));
    const steps = ring + (ca.letter === cb.letter ? 0 : 1);
    return Math.min(steps, 3) / 3;
}

/** 0 for equal or octave-related tempos, rising to 1 at a quarter-octave apart */
export function tempoDistance(a: AudioFeatures | null, b: AudioFeatures | null): number {
    if (!a || !b || !(a.tempo > 0) || !(b.tempo > 0)) return 0.5;
    const octaves = Math.log2(a.tempo / b.tempo);
    const off = Math.abs(octaves - Math.round(octaves));
    return Math.min(1, off / 0.25) + (Math.round(octaves) !== 0 ? 0.1 : 0);
}

function audioDistance(a: AudioFeatures | null, b: AudioFeatures | null): number {
    if (!a || !b) return 0.5;
    const d = [a.energy - b.energy, a.valence - b.valence, a.danceability - b.danceability, a.brightness - b.brightness, a.acousticness - b.acousticness];
    return Math.min(1, Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length) * 2);
}

export function transitionCost(a: SeqItem, b: SeqItem): number {
    return 0.5 * audioDistance(a.audio, b.audio) + 0.3 * harmonicDistance(a.audio, b.audio) + 0.2 * tempoDistance(a.audio, b.audio);
}

/** the arc's shape at relative position p in [0, 1], in [0, 1] */
export function arcShape(arc: EnergyArc, p: number): number {
    switch (arc) {
        case "arc": return Math.sin(Math.PI * p); // warm up, peak in the middle, cool down
        case "rise": return p;
        case "wave": return 0.5 + 0.5 * Math.sin(4 * Math.PI * p - Math.PI / 2);
        case "flat": return 0.5;
    }
}

function totalCost(order: readonly number[], items: readonly SeqItem[], cfg: SequenceConfig, lo: number, hi: number): number {
    let cost = 0;
    let novelRun = 0;
    const n = order.length;
    for (let pos = 0; pos < n; pos++) {
        const item = items[order[pos]!]!;
        const p = n > 1 ? pos / (n - 1) : 0;
        const target = lo + (hi - lo) * arcShape(cfg.arc, p);
        cost += item.audio ? Math.abs(item.audio.energy - target) : 0.25;
        if (pos > 0) cost += transitionCost(items[order[pos - 1]!]!, item);
        for (let back = 1; back <= cfg.artistSeparation && pos - back >= 0; back++) {
            if (items[order[pos - back]!]!.artistKey === item.artistKey) cost += HARD;
        }
        novelRun = item.familiar ? 0 : novelRun + 1;
        if (novelRun > cfg.maxNovelRun) cost += HARD;
    }
    return cost;
}

export function sequence(items: readonly SeqItem[], cfg: SequenceConfig): number[] {
    const n = items.length;
    if (n <= 1) return items.map((_, i) => i);
    const energies = items.filter((i) => i.audio).map((i) => i.audio!.energy);
    const lo = energies.length ? Math.min(...energies) : 0.4;
    const hi = energies.length ? Math.max(...energies) : 0.6;

    // opener: a familiar track near the arc's starting energy, the more confident the better
    const startTarget = lo + (hi - lo) * arcShape(cfg.arc, 0);
    let start = 0;
    let startCost = Infinity;
    items.forEach((it, i) => {
        const c = (it.audio ? Math.abs(it.audio.energy - startTarget) : 0.25) - 0.2 * it.score + (it.familiar ? 0 : 0.5);
        if (c < startCost) {
            startCost = c;
            start = i;
        }
    });

    const order = [start];
    const used = new Set(order);
    while (order.length < n) {
        let best = -1;
        let bestCost = Infinity;
        for (let j = 0; j < n; j++) {
            if (used.has(j)) continue;
            const c = appendCost(order, j, items, cfg) + positionalArc(items[j]!, order.length, n, cfg, lo, hi) - 0.1 * items[j]!.score;
            if (c < bestCost) {
                bestCost = c;
                best = j;
            }
        }
        order.push(best);
        used.add(best);
    }

    // 2-opt
    let current = totalCost(order, items, cfg, lo, hi);
    for (let pass = 0; pass < cfg.twoOptPasses; pass++) {
        let improved = false;
        for (let i = 1; i < n - 1; i++) {
            for (let j = i + 1; j < n; j++) {
                const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
                const c = totalCost(candidate, items, cfg, lo, hi);
                if (c + 1e-9 < current) {
                    order.splice(0, n, ...candidate);
                    current = c;
                    improved = true;
                }
            }
        }
        if (!improved) break;
    }
    return order;
}

/** what appending `j` after `order` adds: the transition and the constraint penalties */
function appendCost(order: readonly number[], j: number, items: readonly SeqItem[], cfg: SequenceConfig): number {
    const item = items[j]!;
    let cost = transitionCost(items[order[order.length - 1]!]!, item);
    for (let back = 1; back <= cfg.artistSeparation && order.length - back >= 0; back++) {
        if (items[order[order.length - back]!]!.artistKey === item.artistKey) cost += HARD;
    }
    if (!item.familiar) {
        let run = 1;
        for (let k = order.length - 1; k >= 0 && !items[order[k]!]!.familiar; k--) run++;
        if (run > cfg.maxNovelRun) cost += HARD;
    }
    return cost;
}

function positionalArc(item: SeqItem, pos: number, n: number, cfg: SequenceConfig, lo: number, hi: number): number {
    const p = n > 1 ? pos / (n - 1) : 0;
    const target = lo + (hi - lo) * arcShape(cfg.arc, p);
    return item.audio ? Math.abs(item.audio.energy - target) : 0.25;
}
