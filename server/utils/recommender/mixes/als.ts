// Collaborative filtering on implicit feedback: weighted ALS (Hu, Koren & Volinsky, ICDM 2008).
//
// Preference p_ui = 1 when user u engaged positively with item i, else 0; confidence c_ui = 1 + alpha * w_ui.
// Alternating closed-form solves, each user (then each item) independently:
//
//   x_u = (Y^T Y + Y^T (C_u - I) Y + reg * I)^-1  Y^T C_u p_u
//
// Y^T Y is computed once per sweep, so a user costs O(k^2 * n_u + k^3) instead of O(k^2 * n_items).
// The factors feed the bandit's user embedding and score the familiar side of mixes; Nafyn never uses them
// to surface another user's tracks (novel suggestions come from the public catalog).
import { Rng, type Mat, cholesky, choleskySolve, mat, matMul, transpose } from "../math";

export interface Interaction {
    user: number,
    item: number,
    /** engagement weight, > 0 */
    weight: number
}

export interface AlsOptions {
    factors: number,
    reg: number,
    alpha: number,
    iterations: number,
    seed: number
}

export interface AlsModel {
    factors: number,
    users: Float64Array[],
    items: Float64Array[]
}

export function trainAls(nUsers: number, nItems: number, data: readonly Interaction[], opts: AlsOptions): AlsModel {
    const k = opts.factors;
    const rng = new Rng(opts.seed);
    const init = () => Float64Array.from({ length: k }, () => 0.1 * rng.normal());
    const users = Array.from({ length: nUsers }, init);
    const items = Array.from({ length: nItems }, init);
    const byUser: Interaction[][] = Array.from({ length: nUsers }, () => []);
    const byItem: Interaction[][] = Array.from({ length: nItems }, () => []);
    for (const d of data) {
        if (!(d.weight > 0)) continue;
        byUser[d.user]!.push(d);
        byItem[d.item]!.push(d);
    }
    for (let it = 0; it < opts.iterations; it++) {
        solveSide(users, items, byUser, (d) => d.item, k, opts);
        solveSide(items, users, byItem, (d) => d.user, k, opts);
    }
    return { factors: k, users, items };
}

function gram(vectors: readonly Float64Array[], k: number): Mat {
    const m = mat(vectors.length, k);
    vectors.forEach((v, i) => m.data.set(v, i * k));
    return matMul(transpose(m), m);
}

function solveSide(
    target: Float64Array[],
    fixed: readonly Float64Array[],
    rows: readonly Interaction[][],
    other: (d: Interaction) => number,
    k: number,
    opts: AlsOptions
): void {
    const yty = gram(fixed, k);
    for (let u = 0; u < target.length; u++) {
        const list = rows[u]!;
        if (list.length === 0) {
            target[u]!.fill(0);
            continue;
        }
        const a = { rows: k, cols: k, data: Float64Array.from(yty.data) };
        const b = new Float64Array(k);
        for (let i = 0; i < k; i++) a.data[i * k + i]! += opts.reg;
        for (const d of list) {
            const y = fixed[other(d)]!;
            const c = 1 + opts.alpha * d.weight;
            // Y^T (C_u - I) Y adds (c - 1) y y^T; Y^T C_u p_u adds c y (p = 1 for every observed pair)
            for (let i = 0; i < k; i++) {
                b[i]! += c * y[i]!;
                const ci = (c - 1) * y[i]!;
                for (let j = 0; j < k; j++) a.data[i * k + j]! += ci * y[j]!;
            }
        }
        target[u] = choleskySolve(cholesky(a), b);
    }
}

/** user-user cosine similarity on the factors, best first, excluding the user */
export function similarUsers(model: AlsModel, user: number, limit: number): { user: number, similarity: number }[] {
    const x = model.users[user]!;
    const nx = Math.hypot(...x);
    if (nx === 0) return [];
    const out: { user: number, similarity: number }[] = [];
    model.users.forEach((y, v) => {
        if (v === user) return;
        const ny = Math.hypot(...y);
        if (ny === 0) return;
        let d = 0;
        for (let i = 0; i < x.length; i++) d += x[i]! * y[i]!;
        out.push({ user: v, similarity: d / (nx * ny) });
    });
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
