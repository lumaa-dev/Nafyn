// Numerical building blocks for the recommender: seeded randomness, dense vectors/matrices in Float64Array
// (row-major), Cholesky factorization and the rank-one updates LinUCB and Neural Thompson Sampling need.
//
// Pure, no Nitro auto-imports, so everything under server/utils/recommender/ runs under `bun test`.
// No linear-algebra dependency: the matrices here are small (tens to a few hundred rows), and owning the
// code is what lets the numerically delicate parts (symmetrization, jitter, periodic re-factorization) be
// explicit instead of hidden.

export type Vec = Float64Array;

/** A dense, row-major, square-or-rectangular matrix. */
export interface Mat {
    rows: number,
    cols: number,
    data: Float64Array
}

// ---------------------------------------------------------------- randomness

/** Deterministic PRNG (mulberry32): same seed, same stream - every test and simulation is reproducible. */
export class Rng {
    private state: number;
    private spare: number | null = null;

    constructor(seed: number) {
        this.state = (seed >>> 0) || 0x9e3779b9;
    }

    /** uniform in [0, 1) */
    next(): number {
        let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    /** standard normal (Box-Muller, the second draw kept for the next call) */
    normal(): number {
        if (this.spare !== null) {
            const s = this.spare;
            this.spare = null;
            return s;
        }
        let u = 0;
        while (u <= Number.EPSILON) u = this.next();
        const v = this.next();
        const r = Math.sqrt(-2 * Math.log(u));
        this.spare = r * Math.sin(2 * Math.PI * v);
        return r * Math.cos(2 * Math.PI * v);
    }

    int(n: number): number {
        return Math.min(n - 1, Math.floor(this.next() * n));
    }

    pick<T>(items: readonly T[]): T {
        return items[this.int(items.length)]!;
    }

    /** index drawn with probability proportional to `weights` (non-negative, not all zero) */
    categorical(weights: ArrayLike<number>): number {
        let total = 0;
        for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]!);
        if (!(total > 0)) return this.int(weights.length);
        let r = this.next() * total;
        for (let i = 0; i < weights.length; i++) {
            r -= Math.max(0, weights[i]!);
            if (r < 0) return i;
        }
        return weights.length - 1;
    }

    shuffle<T>(items: T[]): T[] {
        for (let i = items.length - 1; i > 0; i--) {
            const j = this.int(i + 1);
            [items[i], items[j]] = [items[j]!, items[i]!];
        }
        return items;
    }

    /** Beta(a, b) via two gammas (Marsaglia-Tsang), used by the synthetic data generator */
    beta(a: number, b: number): number {
        const x = this.gamma(a);
        const y = this.gamma(b);
        return x / (x + y);
    }

    gamma(shape: number): number {
        if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.next() || Number.EPSILON, 1 / shape);
        const d = shape - 1 / 3;
        const c = 1 / Math.sqrt(9 * d);
        for (;;) {
            let x: number, v: number;
            do {
                x = this.normal();
                v = 1 + c * x;
            } while (v <= 0);
            v = v * v * v;
            const u = this.next();
            if (u < 1 - 0.0331 * x * x * x * x) return d * v;
            if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
        }
    }
}

/** stable 32-bit string hash (FNV-1a), for seeding per-entity streams and feature hashing */
export function hashString(text: string, seed = 0x811c9dc5): number {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

// ---------------------------------------------------------------- vectors

export function vec(n: number, fill = 0): Vec {
    const v = new Float64Array(n);
    if (fill !== 0) v.fill(fill);
    return v;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
    return s;
}

export function norm(a: ArrayLike<number>): number {
    return Math.sqrt(dot(a, a));
}

/** cosine similarity, 0 when either side is the zero vector */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const na = norm(a);
    const nb = norm(b);
    if (na === 0 || nb === 0) return 0;
    return dot(a, b) / (na * nb);
}

export function normalized(a: ArrayLike<number>): Vec {
    const out = Float64Array.from(a);
    const n = norm(out);
    if (n > 0) for (let i = 0; i < out.length; i++) out[i]! /= n;
    return out;
}

/** a += s * b, in place */
export function axpy(a: Vec, b: ArrayLike<number>, s = 1): Vec {
    for (let i = 0; i < a.length; i++) a[i]! += s * b[i]!;
    return a;
}

export function scale(a: Vec, s: number): Vec {
    for (let i = 0; i < a.length; i++) a[i]! *= s;
    return a;
}

export function concat(...parts: ArrayLike<number>[]): Vec {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Float64Array(n);
    let o = 0;
    for (const p of parts) {
        for (let i = 0; i < p.length; i++) out[o + i] = p[i]!;
        o += p.length;
    }
    return out;
}

export function squaredDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i]! - b[i]!;
        s += d * d;
    }
    return s;
}

export function sigmoid(x: number): number {
    if (x >= 0) {
        const z = Math.exp(-x);
        return 1 / (1 + z);
    }
    const z = Math.exp(x);
    return z / (1 + z);
}

/** log(sum(exp(x))) without overflow */
export function logSumExp(x: ArrayLike<number>): number {
    let m = -Infinity;
    for (let i = 0; i < x.length; i++) if (x[i]! > m) m = x[i]!;
    if (!Number.isFinite(m)) return m;
    let s = 0;
    for (let i = 0; i < x.length; i++) s += Math.exp(x[i]! - m);
    return m + Math.log(s);
}

export function clamp(x: number, lo: number, hi: number): number {
    return x < lo ? lo : x > hi ? hi : x;
}

export function mean(x: ArrayLike<number>): number {
    if (x.length === 0) return 0;
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i]!;
    return s / x.length;
}

/** sample variance (n - 1), 0 for fewer than two values */
export function variance(x: ArrayLike<number>): number {
    if (x.length < 2) return 0;
    const m = mean(x);
    let s = 0;
    for (let i = 0; i < x.length; i++) s += (x[i]! - m) ** 2;
    return s / (x.length - 1);
}

// ---------------------------------------------------------------- matrices

export function mat(rows: number, cols: number): Mat {
    return { rows, cols, data: new Float64Array(rows * cols) };
}

export function identity(n: number, s = 1): Mat {
    const m = mat(n, n);
    for (let i = 0; i < n; i++) m.data[i * n + i] = s;
    return m;
}

export function cloneMat(m: Mat): Mat {
    return { rows: m.rows, cols: m.cols, data: Float64Array.from(m.data) };
}

export function matVec(m: Mat, x: ArrayLike<number>, out: Vec = vec(m.rows)): Vec {
    const { rows, cols, data } = m;
    for (let i = 0; i < rows; i++) {
        let s = 0;
        const o = i * cols;
        for (let j = 0; j < cols; j++) s += data[o + j]! * x[j]!;
        out[i] = s;
    }
    return out;
}

/** x^T M x for a square M */
export function quadForm(m: Mat, x: ArrayLike<number>): number {
    const n = m.rows;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const xi = x[i]!;
        if (xi === 0) continue;
        let row = 0;
        const o = i * n;
        for (let j = 0; j < n; j++) row += m.data[o + j]! * x[j]!;
        s += xi * row;
    }
    return s;
}

/** M += s * x x^T (symmetric rank-one update) */
export function addOuter(m: Mat, x: ArrayLike<number>, s = 1): void {
    const n = m.rows;
    for (let i = 0; i < n; i++) {
        const xi = s * x[i]!;
        if (xi === 0) continue;
        const o = i * n;
        for (let j = 0; j < n; j++) m.data[o + j]! += xi * x[j]!;
    }
}

/** (A + B) / 2 written back into A - rounding drift makes repeated rank-one updates slightly asymmetric */
export function symmetrize(m: Mat): void {
    const n = m.rows;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const v = 0.5 * (m.data[i * n + j]! + m.data[j * n + i]!);
            m.data[i * n + j] = v;
            m.data[j * n + i] = v;
        }
    }
}

export function matMul(a: Mat, b: Mat): Mat {
    if (a.cols !== b.rows) throw new Error(`matMul: ${a.rows}x${a.cols} * ${b.rows}x${b.cols}`);
    const out = mat(a.rows, b.cols);
    for (let i = 0; i < a.rows; i++) {
        for (let k = 0; k < a.cols; k++) {
            const aik = a.data[i * a.cols + k]!;
            if (aik === 0) continue;
            const bo = k * b.cols;
            const oo = i * b.cols;
            for (let j = 0; j < b.cols; j++) out.data[oo + j]! += aik * b.data[bo + j]!;
        }
    }
    return out;
}

export function transpose(a: Mat): Mat {
    const out = mat(a.cols, a.rows);
    for (let i = 0; i < a.rows; i++) for (let j = 0; j < a.cols; j++) out.data[j * a.rows + i] = a.data[i * a.cols + j]!;
    return out;
}

/**
 * Lower-triangular Cholesky factor L of a symmetric positive-definite A (A = L L^T).
 *
 * When A is only semi-definite up to rounding, a growing diagonal jitter is added and the factorization
 * retried; a matrix that still fails after that is genuinely broken and throws rather than returning NaNs.
 */
export function cholesky(a: Mat, maxJitterTries = 6): Mat {
    const n = a.rows;
    let jitter = 0;
    for (let attempt = 0; attempt <= maxJitterTries; attempt++) {
        const l = mat(n, n);
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
            for (let j = 0; j <= i; j++) {
                let s = a.data[i * n + j]! + (i === j ? jitter : 0);
                for (let k = 0; k < j; k++) s -= l.data[i * n + k]! * l.data[j * n + k]!;
                if (i === j) {
                    if (!(s > 0) || !Number.isFinite(s)) {
                        ok = false;
                        break;
                    }
                    l.data[i * n + i] = Math.sqrt(s);
                } else {
                    l.data[i * n + j] = s / l.data[j * n + j]!;
                }
            }
        }
        if (ok) return l;
        let scaleDiag = 0;
        for (let i = 0; i < n; i++) scaleDiag = Math.max(scaleDiag, Math.abs(a.data[i * n + i]!));
        jitter = jitter === 0 ? 1e-10 * Math.max(1, scaleDiag) : jitter * 100;
    }
    throw new Error("cholesky: matrix is not positive definite");
}

/** solves A x = b given A's Cholesky factor L */
export function choleskySolve(l: Mat, b: ArrayLike<number>): Vec {
    const n = l.rows;
    const y = vec(n);
    for (let i = 0; i < n; i++) {
        let s = b[i]!;
        for (let k = 0; k < i; k++) s -= l.data[i * n + k]! * y[k]!;
        y[i] = s / l.data[i * n + i]!;
    }
    const x = vec(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i]!;
        for (let k = i + 1; k < n; k++) s -= l.data[k * n + i]! * x[k]!;
        x[i] = s / l.data[i * n + i]!;
    }
    return x;
}

/** inverse of a symmetric positive-definite matrix through its Cholesky factor */
export function spdInverse(a: Mat): Mat {
    const n = a.rows;
    const l = cholesky(a);
    const inv = mat(n, n);
    const e = vec(n);
    for (let j = 0; j < n; j++) {
        e.fill(0);
        e[j] = 1;
        const col = choleskySolve(l, e);
        for (let i = 0; i < n; i++) inv.data[i * n + j] = col[i]!;
    }
    symmetrize(inv);
    return inv;
}

/**
 * Sherman-Morrison: given Ainv = A^-1, overwrites it with (A + w x x^T)^-1 in O(d^2).
 * Returns false (and leaves Ainv untouched) when the update would be numerically singular.
 */
export function shermanMorrisonUpdate(ainv: Mat, x: ArrayLike<number>, w = 1): boolean {
    const n = ainv.rows;
    const u = matVec(ainv, x); // A^-1 x (A^-1 is symmetric, so this is also x^T A^-1)
    const denom = 1 + w * dot(x, u);
    if (!(denom > 1e-12) || !Number.isFinite(denom)) return false;
    const c = w / denom;
    for (let i = 0; i < n; i++) {
        const ui = c * u[i]!;
        if (ui === 0) continue;
        const o = i * n;
        for (let j = 0; j < n; j++) ainv.data[o + j]! -= ui * u[j]!;
    }
    return true;
}

// ---------------------------------------------------------------- statistics

/** inverse of the standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9) */
export function normalQuantile(p: number): number {
    if (!(p > 0 && p < 1)) throw new Error(`normalQuantile: p must be in (0, 1), got ${p}`);
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const lo = 0.02425;
    if (p < lo) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
    }
    if (p > 1 - lo) return -normalQuantile(1 - p);
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
        / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** argsort, descending, ties broken by index so the order is deterministic */
export function argsortDesc(x: ArrayLike<number>): number[] {
    const idx = Array.from({ length: x.length }, (_, i) => i);
    idx.sort((i, j) => (x[j]! - x[i]!) || (i - j));
    return idx;
}

// ---------------------------------------------------------------- serialization

/** Float64Array <-> base64, for storing model parameters in the database without JSON number bloat */
export function f64ToBase64(v: Float64Array): string {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

export function base64ToF64(text: string): Float64Array {
    const buf = Buffer.from(text, "base64");
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    return new Float64Array(copy.buffer);
}
