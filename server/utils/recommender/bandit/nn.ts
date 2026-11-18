// Differentiable reward models for the neural bandit and the offline reward model (direct method / DR):
// a multi-layer perceptron and a second-order factorization machine (Rendle 2010), both over a flat
// Float64Array of parameters so the bandit can take per-example gradients g = df/dtheta (Neural Thompson
// Sampling needs exactly that) and the trainer can run Adam over any of them.
//
// Hand-written forward and backward passes: Nafyn runs on Node/Bun in an alpine image, where a native
// tensor library is a heavy, fragile dependency, and these models are small (a few thousand parameters).
// tests/recommender/nn.test.ts checks every gradient against finite differences.
import { type Rng, sigmoid } from "../math";

export interface DiffModel {
    readonly type: "mlp" | "fm",
    readonly inputDim: number,
    readonly params: Float64Array,
    /** network width m, used by Neural Thompson Sampling's 1/m scaling */
    readonly width: number,
    /** [offset, length] of the output layer's parameters inside `params` */
    readonly lastLayer: readonly [number, number],
    forward(x: ArrayLike<number>): number,
    /** f(x), and df/dtheta written into `grad` (length params.length) */
    forwardGrad(x: ArrayLike<number>, grad: Float64Array): number,
    clone(): DiffModel
}

// ---------------------------------------------------------------- MLP

export class Mlp implements DiffModel {
    readonly type = "mlp" as const;
    readonly inputDim: number;
    readonly sizes: number[];
    readonly params: Float64Array;
    readonly width: number;
    readonly lastLayer: readonly [number, number];
    // per layer: offset of W (out x in, row-major) and of b (out)
    private readonly wOffset: number[] = [];
    private readonly bOffset: number[] = [];
    // scratch activations (pre- and post-ReLU) reused across calls
    private readonly z: Float64Array[];
    private readonly h: Float64Array[];

    constructor(inputDim: number, hidden: number[], rng: Rng | null, params?: Float64Array) {
        if (hidden.length === 0) throw new Error("Mlp: at least one hidden layer");
        this.inputDim = inputDim;
        this.sizes = [inputDim, ...hidden, 1];
        this.width = Math.max(...hidden);
        let offset = 0;
        for (let l = 1; l < this.sizes.length; l++) {
            this.wOffset.push(offset);
            offset += this.sizes[l]! * this.sizes[l - 1]!;
            this.bOffset.push(offset);
            offset += this.sizes[l]!;
        }
        const lastW = this.wOffset[this.wOffset.length - 1]!;
        this.lastLayer = [lastW, offset - lastW];
        this.params = params ? Float64Array.from(params) : new Float64Array(offset);
        if (this.params.length !== offset) throw new Error(`Mlp: expected ${offset} parameters, got ${this.params.length}`);
        if (!params) {
            if (!rng) throw new Error("Mlp: rng needed to initialize");
            // He initialization for the ReLU layers, small output layer so f(x; theta_0) starts near 0
            for (let l = 1; l < this.sizes.length; l++) {
                const fanIn = this.sizes[l - 1]!;
                const std = l === this.sizes.length - 1 ? 0.1 / Math.sqrt(fanIn) : Math.sqrt(2 / fanIn);
                const w0 = this.wOffset[l - 1]!;
                for (let i = 0; i < this.sizes[l]! * fanIn; i++) this.params[w0 + i] = std * rng.normal();
            }
        }
        this.z = this.sizes.map((n) => new Float64Array(n));
        this.h = this.sizes.map((n) => new Float64Array(n));
    }

    get nParams(): number {
        return this.params.length;
    }

    forward(x: ArrayLike<number>): number {
        const p = this.params;
        const L = this.sizes.length - 1;
        for (let i = 0; i < this.inputDim; i++) this.h[0]![i] = x[i]!;
        for (let l = 1; l <= L; l++) {
            const nin = this.sizes[l - 1]!;
            const nout = this.sizes[l]!;
            const w0 = this.wOffset[l - 1]!;
            const b0 = this.bOffset[l - 1]!;
            const hin = this.h[l - 1]!;
            const z = this.z[l]!;
            const hout = this.h[l]!;
            for (let o = 0; o < nout; o++) {
                let s = p[b0 + o]!;
                const row = w0 + o * nin;
                for (let i = 0; i < nin; i++) s += p[row + i]! * hin[i]!;
                z[o] = s;
                hout[o] = l === L ? s : (s > 0 ? s : 0);
            }
        }
        return this.h[L]![0]!;
    }

    forwardGrad(x: ArrayLike<number>, grad: Float64Array): number {
        const out = this.forward(x);
        const p = this.params;
        const L = this.sizes.length - 1;
        // delta = d out / d z_l, starting at the linear output (d out / d z_L = 1)
        let delta = new Float64Array([1]);
        for (let l = L; l >= 1; l--) {
            const nin = this.sizes[l - 1]!;
            const nout = this.sizes[l]!;
            const w0 = this.wOffset[l - 1]!;
            const b0 = this.bOffset[l - 1]!;
            const hin = this.h[l - 1]!;
            for (let o = 0; o < nout; o++) {
                const d = delta[o]!;
                grad[b0 + o] = d;
                const row = w0 + o * nin;
                for (let i = 0; i < nin; i++) grad[row + i] = d * hin[i]!;
            }
            if (l === 1) break;
            const next = new Float64Array(nin);
            const zin = this.z[l - 1]!;
            for (let i = 0; i < nin; i++) {
                if (zin[i]! <= 0) continue; // ReLU'
                let s = 0;
                for (let o = 0; o < nout; o++) s += delta[o]! * p[w0 + o * nin + i]!;
                next[i] = s;
            }
            delta = next;
        }
        return out;
    }

    /** activations of the last hidden layer for x, plus the bias input: the output layer's own gradient */
    lastHidden(x: ArrayLike<number>): Float64Array {
        this.forward(x);
        const h = this.h[this.sizes.length - 2]!;
        const out = new Float64Array(h.length + 1);
        out.set(h);
        out[h.length] = 1;
        return out;
    }

    clone(): Mlp {
        return new Mlp(this.inputDim, this.sizes.slice(1, -1), null, this.params);
    }
}

// ---------------------------------------------------------------- factorization machine

/**
 * f(x) = w0 + sum_i w_i x_i + sum_{i<j} <v_i, v_j> x_i x_j, computed in O(k n) with Rendle's identity
 *        sum_{i<j} <v_i, v_j> x_i x_j = 1/2 sum_f [ (sum_i v_if x_i)^2 - sum_i v_if^2 x_i^2 ].
 * Parameter layout: [w0, w (n), V (n x k, row-major)]. The "last layer" is the linear part [w0, w].
 */
export class FactorizationMachine implements DiffModel {
    readonly type = "fm" as const;
    readonly inputDim: number;
    readonly rank: number;
    readonly params: Float64Array;
    readonly width: number;
    readonly lastLayer: readonly [number, number];
    private readonly s: Float64Array;

    constructor(inputDim: number, rank: number, rng: Rng | null, params?: Float64Array) {
        this.inputDim = inputDim;
        this.rank = rank;
        this.width = rank;
        const n = 1 + inputDim + inputDim * rank;
        this.lastLayer = [0, 1 + inputDim];
        this.params = params ? Float64Array.from(params) : new Float64Array(n);
        if (this.params.length !== n) throw new Error(`FM: expected ${n} parameters, got ${this.params.length}`);
        if (!params) {
            if (!rng) throw new Error("FM: rng needed to initialize");
            for (let i = 1 + inputDim; i < n; i++) this.params[i] = 0.05 * rng.normal();
        }
        this.s = new Float64Array(rank);
    }

    forward(x: ArrayLike<number>): number {
        const p = this.params;
        const n = this.inputDim;
        const k = this.rank;
        let out = p[0]!;
        for (let i = 0; i < n; i++) out += p[1 + i]! * x[i]!;
        const v0 = 1 + n;
        let pair = 0;
        for (let f = 0; f < k; f++) {
            let s = 0;
            let sq = 0;
            for (let i = 0; i < n; i++) {
                const xi = x[i]!;
                if (xi === 0) continue;
                const v = p[v0 + i * k + f]!;
                s += v * xi;
                sq += v * v * xi * xi;
            }
            this.s[f] = s;
            pair += s * s - sq;
        }
        return out + 0.5 * pair;
    }

    forwardGrad(x: ArrayLike<number>, grad: Float64Array): number {
        const out = this.forward(x);
        const p = this.params;
        const n = this.inputDim;
        const k = this.rank;
        grad[0] = 1;
        const v0 = 1 + n;
        for (let i = 0; i < n; i++) {
            const xi = x[i]!;
            grad[1 + i] = xi;
            for (let f = 0; f < k; f++) {
                // d/dv_if = x_i * s_f - v_if * x_i^2
                grad[v0 + i * k + f] = xi === 0 ? 0 : xi * this.s[f]! - p[v0 + i * k + f]! * xi * xi;
            }
        }
        return out;
    }

    /** the naive O(k n^2) pairwise form, kept for the test that proves the fast form equals it */
    forwardNaive(x: ArrayLike<number>): number {
        const p = this.params;
        const n = this.inputDim;
        const k = this.rank;
        let out = p[0]!;
        for (let i = 0; i < n; i++) out += p[1 + i]! * x[i]!;
        const v0 = 1 + n;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let d = 0;
                for (let f = 0; f < k; f++) d += p[v0 + i * k + f]! * p[v0 + j * k + f]!;
                out += d * x[i]! * x[j]!;
            }
        }
        return out;
    }

    clone(): FactorizationMachine {
        return new FactorizationMachine(this.inputDim, this.rank, null, this.params);
    }
}

export function createModel(type: "mlp" | "fm", inputDim: number, opts: { hidden: number[], fmRank: number }, rng: Rng): DiffModel {
    return type === "fm" ? new FactorizationMachine(inputDim, opts.fmRank, rng) : new Mlp(inputDim, opts.hidden, rng);
}

export function restoreModel(type: "mlp" | "fm", inputDim: number, opts: { hidden: number[], fmRank: number }, params: Float64Array): DiffModel {
    return type === "fm" ? new FactorizationMachine(inputDim, opts.fmRank, null, params) : new Mlp(inputDim, opts.hidden, null, params);
}

// ---------------------------------------------------------------- training

export interface TrainOptions {
    /** "mse": f(x) regresses the reward directly. "bce": sigmoid(f(x)) is a probability (binary rewards) */
    loss: "mse" | "bce",
    epochs?: number,
    steps?: number,
    batchSize: number,
    learningRate: number,
    /** L2 pull towards `anchor` (or towards 0 without one), per example: the loss is mean + reg/2 ||theta - anchor||^2 */
    reg: number,
    anchor?: Float64Array,
    rng: Rng
}

/** Adam (Kingma & Ba 2015) over minibatches of weighted examples. Returns the last epoch's mean loss. */
export function trainModel(
    model: DiffModel,
    xs: readonly ArrayLike<number>[],
    ys: ArrayLike<number>,
    weights: ArrayLike<number> | null,
    opts: TrainOptions
): number {
    const n = xs.length;
    if (n === 0) return 0;
    const P = model.params.length;
    const m = new Float64Array(P);
    const v = new Float64Array(P);
    const g = new Float64Array(P);
    const gx = new Float64Array(P);
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    let t = 0;
    const order = Array.from({ length: n }, (_, i) => i);
    const totalSteps = opts.steps ?? Math.ceil(n / opts.batchSize) * (opts.epochs ?? 10);
    let lastLoss = 0;
    let cursor = n;

    for (let step = 0; step < totalSteps; step++) {
        if (cursor >= n) {
            opts.rng.shuffle(order);
            cursor = 0;
        }
        const batch = order.slice(cursor, cursor + opts.batchSize);
        cursor += opts.batchSize;
        g.fill(0);
        let wsum = 0;
        let loss = 0;
        for (const i of batch) {
            const w = weights ? weights[i]! : 1;
            if (!(w > 0)) continue;
            const f = model.forwardGrad(xs[i]!, gx);
            const y = ys[i]!;
            let dl: number;
            if (opts.loss === "bce") {
                const pHat = sigmoid(f);
                dl = pHat - y;
                const pc = Math.min(1 - 1e-12, Math.max(1e-12, pHat));
                loss += -w * (y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
            } else {
                dl = f - y;
                loss += 0.5 * w * dl * dl;
            }
            for (let j = 0; j < P; j++) g[j]! += w * dl * gx[j]!;
            wsum += w;
        }
        if (wsum === 0) continue;
        const params = model.params;
        t++;
        const lr = opts.learningRate;
        const b1t = 1 - Math.pow(beta1, t);
        const b2t = 1 - Math.pow(beta2, t);
        for (let j = 0; j < P; j++) {
            const anchor = opts.anchor ? opts.anchor[j]! : 0;
            const gj = g[j]! / wsum + opts.reg * (params[j]! - anchor);
            m[j] = beta1 * m[j]! + (1 - beta1) * gj;
            v[j] = beta2 * v[j]! + (1 - beta2) * gj * gj;
            params[j]! -= lr * (m[j]! / b1t) / (Math.sqrt(v[j]! / b2t) + eps);
        }
        lastLoss = loss / wsum;
    }
    return lastLoss;
}
