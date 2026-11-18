// Embedding and graph similarity.
//
//   * track embeddings from co-occurrence: tracks that sit together in playlists and listening sessions,
//     PPMI-weighted (Levy & Goldberg: factorizing the shifted PMI matrix is what word2vec / item2vec do
//     implicitly), factorized by randomized SVD (Halko, Martinsson & Tropp 2011);
//   * an artist graph (similar-artist edges from ListenBrainz' session-based similarity, plus artists that
//     co-occur in the user's own playlists and sessions), walked by personalized PageRank from a mode's
//     artists: an artist two hops away through strong edges outranks one directly linked by a weak one.
import { Rng, normalized } from "../math";

// ---------------------------------------------------------------- co-occurrence embeddings

export interface Cooccurrence {
    /** sparse symmetric counts: row -> (col -> count) */
    rows: Map<number, Map<number, number>>,
    n: number
}

/** counts pairs inside each group (a playlist, or a session) within a sliding window */
export function countCooccurrences(n: number, groups: readonly number[][], window = 10): Cooccurrence {
    const rows = new Map<number, Map<number, number>>();
    const add = (a: number, b: number, w: number) => {
        let row = rows.get(a);
        if (!row) rows.set(a, (row = new Map()));
        row.set(b, (row.get(b) ?? 0) + w);
    };
    for (const g of groups) {
        for (let i = 0; i < g.length; i++) {
            for (let j = i + 1; j < Math.min(g.length, i + 1 + window); j++) {
                if (g[i] === g[j]) continue;
                const w = 1 / (j - i); // nearer neighbours count more
                add(g[i]!, g[j]!, w);
                add(g[j]!, g[i]!, w);
            }
        }
    }
    return { rows, n };
}

/** positive PMI, shifted by log(shift) (shift = word2vec's negative-sample count) */
export function ppmi(co: Cooccurrence, shift = 1): Map<number, Map<number, number>> {
    let total = 0;
    const rowSum = new Map<number, number>();
    for (const [i, row] of co.rows) {
        let s = 0;
        for (const c of row.values()) s += c;
        rowSum.set(i, s);
        total += s;
    }
    const out = new Map<number, Map<number, number>>();
    for (const [i, row] of co.rows) {
        const r = new Map<number, number>();
        for (const [j, c] of row) {
            const pmi = Math.log((c * total) / (rowSum.get(i)! * rowSum.get(j)!)) - Math.log(shift);
            if (pmi > 0) r.set(j, pmi);
        }
        if (r.size) out.set(i, r);
    }
    return out;
}

function sparseMulDense(m: Map<number, Map<number, number>>, n: number, dense: Float64Array[], k: number): Float64Array[] {
    const out = Array.from({ length: n }, () => new Float64Array(k));
    for (const [i, row] of m) {
        const o = out[i]!;
        for (const [j, v] of row) {
            const d = dense[j]!;
            for (let c = 0; c < k; c++) o[c]! += v * d[c]!;
        }
    }
    return out;
}

/** modified Gram-Schmidt on the columns of an n x k matrix stored as rows */
function orthonormalizeColumns(rows: Float64Array[], k: number): void {
    for (let c = 0; c < k; c++) {
        for (let p = 0; p < c; p++) {
            let d = 0;
            for (const r of rows) d += r[c]! * r[p]!;
            for (const r of rows) r[c]! -= d * r[p]!;
        }
        let nrm = 0;
        for (const r of rows) nrm += r[c]! ** 2;
        nrm = Math.sqrt(nrm);
        if (nrm > 1e-12) for (const r of rows) r[c]! /= nrm;
    }
}

/** Jacobi eigen-decomposition of a small symmetric matrix: eigenvalues and eigenvectors (columns) */
export function symmetricEigen(a: Float64Array, k: number): { values: Float64Array, vectors: Float64Array } {
    const m = Float64Array.from(a);
    const v = new Float64Array(k * k);
    for (let i = 0; i < k; i++) v[i * k + i] = 1;
    for (let sweep = 0; sweep < 100; sweep++) {
        let off = 0;
        for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) off += m[p * k + q]! ** 2;
        if (off < 1e-20) break;
        for (let p = 0; p < k; p++) {
            for (let q = p + 1; q < k; q++) {
                const apq = m[p * k + q]!;
                if (Math.abs(apq) < 1e-15) continue;
                const theta = (m[q * k + q]! - m[p * k + p]!) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let r = 0; r < k; r++) {
                    const mrp = m[r * k + p]!;
                    const mrq = m[r * k + q]!;
                    m[r * k + p] = c * mrp - s * mrq;
                    m[r * k + q] = s * mrp + c * mrq;
                }
                for (let r = 0; r < k; r++) {
                    const mpr = m[p * k + r]!;
                    const mqr = m[q * k + r]!;
                    m[p * k + r] = c * mpr - s * mqr;
                    m[q * k + r] = s * mpr + c * mqr;
                }
                for (let r = 0; r < k; r++) {
                    const vrp = v[r * k + p]!;
                    const vrq = v[r * k + q]!;
                    v[r * k + p] = c * vrp - s * vrq;
                    v[r * k + q] = s * vrp + c * vrq;
                }
            }
        }
    }
    return { values: Float64Array.from({ length: k }, (_, i) => m[i * k + i]!), vectors: v };
}

/**
 * Rank-k embeddings of a sparse symmetric matrix M ~ U S U^T by randomized subspace iteration;
 * row i of the result is U_i * sqrt(|S|), L2-normalized. Rows with no entries get the zero vector.
 */
export function randomizedEmbedding(m: Map<number, Map<number, number>>, n: number, k: number, seed: number, powerIterations = 4): Float64Array[] {
    const dim = Math.min(k, Math.max(1, m.size));
    const rng = new Rng(seed);
    let q: Float64Array[] = Array.from({ length: n }, () => Float64Array.from({ length: dim }, () => rng.normal()));
    for (let it = 0; it <= powerIterations; it++) {
        q = sparseMulDense(m, n, q, dim);
        orthonormalizeColumns(q, dim);
    }
    // B = Q^T M Q (dim x dim), symmetric
    const mq = sparseMulDense(m, n, q, dim);
    const b = new Float64Array(dim * dim);
    for (let i = 0; i < n; i++) {
        for (let r = 0; r < dim; r++) {
            const qr = q[i]![r]!;
            if (qr === 0) continue;
            for (let c = 0; c < dim; c++) b[r * dim + c]! += qr * mq[i]![c]!;
        }
    }
    for (let r = 0; r < dim; r++) for (let c = r + 1; c < dim; c++) {
        const avg = 0.5 * (b[r * dim + c]! + b[c * dim + r]!);
        b[r * dim + c] = avg;
        b[c * dim + r] = avg;
    }
    const { values, vectors } = symmetricEigen(b, dim);
    const out: Float64Array[] = Array.from({ length: n }, () => new Float64Array(k));
    for (let i = 0; i < n; i++) {
        if (!m.has(i)) continue;
        for (let c = 0; c < dim; c++) {
            let s = 0;
            for (let r = 0; r < dim; r++) s += q[i]![r]! * vectors[r * dim + c]!;
            out[i]![c] = s * Math.sqrt(Math.abs(values[c]!));
        }
        out[i] = normalized(out[i]!);
    }
    return out;
}

// ---------------------------------------------------------------- artist graph

export class ArtistGraph {
    private readonly edges = new Map<string, Map<string, number>>();

    addEdge(a: string, b: string, weight: number): void {
        if (a === b || !(weight > 0)) return;
        for (const [x, y] of [[a, b], [b, a]] as const) {
            let row = this.edges.get(x);
            if (!row) this.edges.set(x, (row = new Map()));
            row.set(y, (row.get(y) ?? 0) + weight);
        }
    }

    neighbours(a: string): ReadonlyMap<string, number> {
        return this.edges.get(a) ?? new Map();
    }

    get size(): number {
        return this.edges.size;
    }

    /**
     * Personalized PageRank: the stationary distribution of a walk that follows weighted edges and jumps back
     * to the seeds (weighted) with probability 1 - damping. Power iteration until the L1 change is tiny.
     */
    personalizedPageRank(seeds: ReadonlyMap<string, number>, damping = 0.85, iterations = 50): Map<string, number> {
        let seedTotal = 0;
        for (const w of seeds.values()) seedTotal += Math.max(0, w);
        if (!(seedTotal > 0)) return new Map();
        const restart = new Map<string, number>();
        for (const [s, w] of seeds) if (w > 0) restart.set(s, w / seedTotal);
        const outWeight = new Map<string, number>();
        for (const [a, row] of this.edges) {
            let s = 0;
            for (const w of row.values()) s += w;
            outWeight.set(a, s);
        }
        let rank = new Map(restart);
        for (let it = 0; it < iterations; it++) {
            const next = new Map<string, number>();
            let dangling = 0;
            for (const [a, r] of rank) {
                const row = this.edges.get(a);
                if (!row || !outWeight.get(a)) {
                    dangling += r;
                    continue;
                }
                const total = outWeight.get(a)!;
                for (const [b, w] of row) next.set(b, (next.get(b) ?? 0) + (damping * r * w) / total);
            }
            // restart mass, plus the mass of walkers stuck at a dead end, goes back to the seeds
            for (const [s, p] of restart) next.set(s, (next.get(s) ?? 0) + ((1 - damping) + damping * dangling) * p);
            let delta = 0;
            for (const [a, r] of next) delta += Math.abs(r - (rank.get(a) ?? 0));
            for (const [a, r] of rank) if (!next.has(a)) delta += r;
            rank = next;
            if (delta < 1e-9) break;
        }
        return rank;
    }
}
