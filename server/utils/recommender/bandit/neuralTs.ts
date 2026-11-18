// Neural Thompson Sampling (Zhang, Zhou, Liang & Gu, ICLR 2021) and its UCB twin NeuralUCB (Zhou, Li & Gu,
// ICML 2020), over any DiffModel (MLP or factorization machine).
//
//   r_hat(x) = f(x; theta)
//   g(x)     = df/dtheta at the current theta
//   U        = ridge * I + sum_t g_t g_t^T / m            (m = network width)
//   sigma(x) = sqrt(ridge * g(x)^T U^-1 g(x) / m)
//   Score(x) = r_hat(x) + lambda * sigma(x)
//       Thompson sampling: lambda ~ N(0, nu^2) per arm, so the score is a draw from N(r_hat, nu^2 sigma^2)
//       NeuralUCB:         lambda constant
//
// U over every parameter is P x P, too large to invert per request, so two forms are offered:
//   "diag"       - the diagonal of U over all parameters (what the paper's experiments use);
//   "last_layer" - the full U over the output layer's parameters only (its gradient is the last hidden layer's
//                  activations plus the bias input), inverted incrementally by Sherman-Morrison.
//
// Training (the paper's step 3): every `trainEvery` updates, `trainSteps` gradient steps on the replay buffer,
// minimizing  mean_i (f(x_i) - r_i)^2 / 2  +  (ridge * m / N) / 2 * ||theta - theta_0||^2,
// i.e. the paper's  sum_i (f - r)^2 / 2 + m * ridge / 2 * ||theta - theta_0||^2  divided by the N examples.
import {
    type Mat, type Rng, base64ToF64, f64ToBase64, identity, quadForm, shermanMorrisonUpdate
} from "../math";
import { type DiffModel, Mlp, restoreModel, trainModel } from "./nn";
import { type BanditPolicy, type PolicyKind, type Prediction, constantLambdas, gaussianLambdas } from "./score";

export interface NeuralBanditOptions {
    mode: "ts" | "ucb",
    ridge: number,
    /** TS: lambda ~ N(0, nu^2). UCB: lambda = nu */
    nu: number,
    uncertainty: "diag" | "last_layer",
    learningRate: number,
    trainEvery: number,
    trainSteps: number,
    trainBatch: number,
    replayCapacity: number,
    hidden: number[],
    fmRank: number
}

export interface SerializedNeural {
    kind: "neural_ts" | "neural_ucb",
    options: NeuralBanditOptions,
    model: "mlp" | "fm",
    dim: number,
    params: string,
    anchor: string,
    /** diag: U's diagonal. last_layer: U^-1 (full, row-major) */
    u: string,
    updates: number
}

export class NeuralBanditPolicy implements BanditPolicy {
    readonly kind: PolicyKind;
    readonly dim: number;
    readonly stochastic: boolean;
    readonly options: NeuralBanditOptions;
    readonly model: DiffModel;
    /** theta_0, the regularization anchor */
    private readonly anchor: Float64Array;
    private readonly uDiag: Float64Array | null;
    private uInv: Mat | null;
    private readonly grad: Float64Array;
    private readonly buffer: { x: Float64Array, r: number, w: number }[] = [];
    private readonly trainRng: Rng;
    updates = 0;

    constructor(model: DiffModel, options: NeuralBanditOptions, rng: Rng) {
        this.model = model;
        this.dim = model.inputDim;
        this.options = options;
        this.kind = options.mode === "ts" ? "neural_ts" : "neural_ucb";
        this.stochastic = options.mode === "ts";
        this.anchor = Float64Array.from(model.params);
        this.grad = new Float64Array(model.params.length);
        this.trainRng = rng;
        if (options.uncertainty === "diag") {
            this.uDiag = new Float64Array(model.params.length).fill(options.ridge);
            this.uInv = null;
        } else {
            this.uDiag = null;
            this.uInv = identity(this.lastLayerGradientSize(), 1 / options.ridge);
        }
    }

    get nu(): number {
        return this.options.nu;
    }

    private lastLayerGradientSize(): number {
        return this.model.lastLayer[1];
    }

    /** the gradient the uncertainty is computed over: every parameter (diag), or the output layer's */
    private gradientFor(x: ArrayLike<number>): { f: number, g: Float64Array } {
        const f = this.model.forwardGrad(x, this.grad);
        if (this.uDiag) return { f, g: this.grad };
        const [offset, length] = this.model.lastLayer;
        return { f, g: this.grad.subarray(offset, offset + length) };
    }

    predict(xs: readonly Float64Array[]): Prediction {
        const n = xs.length;
        const mean = new Float64Array(n);
        const sigma = new Float64Array(n);
        const m = this.model.width;
        const ridge = this.options.ridge;
        for (let i = 0; i < n; i++) {
            const { f, g } = this.gradientFor(xs[i]!);
            mean[i] = f;
            let q: number;
            if (this.uDiag) {
                q = 0;
                for (let j = 0; j < g.length; j++) q += (g[j]! * g[j]!) / this.uDiag[j]!;
            } else {
                q = quadForm(this.uInv!, g);
            }
            sigma[i] = Math.sqrt(Math.max(0, (ridge * q) / m));
        }
        return { mean, sigma };
    }

    lambdas(n: number, rng: Rng): Float64Array {
        return this.options.mode === "ts" ? gaussianLambdas(n, this.options.nu, rng) : constantLambdas(n, this.options.nu);
    }

    update(x: Float64Array, reward: number, weight = 1): void {
        if (!(weight > 0) || !Number.isFinite(reward)) return;
        // U grows with the gradient at the parameters the decision was made with (before retraining)
        const { g } = this.gradientFor(x);
        const m = this.model.width;
        if (this.uDiag) {
            for (let j = 0; j < g.length; j++) this.uDiag[j]! += (weight * g[j]! * g[j]!) / m;
        } else if (!shermanMorrisonUpdate(this.uInv!, g, weight / m)) {
            // numerically singular update: skip it rather than corrupt U^-1
        }
        this.remember(x, reward, weight);
        this.updates++;
        if (this.updates % Math.max(1, this.options.trainEvery) === 0) this.train();
    }

    /** adds an observation to the replay buffer without touching U (used when rebuilding from logs) */
    remember(x: Float64Array, reward: number, weight = 1): void {
        this.buffer.push({ x, r: reward, w: weight });
        if (this.buffer.length > this.options.replayCapacity) this.buffer.splice(0, this.buffer.length - this.options.replayCapacity);
    }

    bufferSize(): number {
        return this.buffer.length;
    }

    train(steps = this.options.trainSteps): number {
        if (this.buffer.length === 0) return 0;
        const N = this.buffer.length;
        return trainModel(
            this.model,
            this.buffer.map((b) => b.x),
            this.buffer.map((b) => b.r),
            this.buffer.map((b) => b.w),
            {
                loss: "mse",
                steps,
                batchSize: this.options.trainBatch,
                learningRate: this.options.learningRate,
                reg: (this.options.ridge * this.model.width) / N,
                anchor: this.anchor,
                rng: this.trainRng
            }
        );
    }

    serialize(): SerializedNeural {
        return {
            kind: this.kind as "neural_ts" | "neural_ucb",
            options: this.options,
            model: this.model.type,
            dim: this.dim,
            params: f64ToBase64(this.model.params),
            anchor: f64ToBase64(this.anchor),
            u: f64ToBase64(this.uDiag ?? this.uInv!.data),
            updates: this.updates
        };
    }

    static deserialize(s: SerializedNeural, rng: Rng): NeuralBanditPolicy {
        const model = restoreModel(s.model, s.dim, { hidden: s.options.hidden, fmRank: s.options.fmRank }, base64ToF64(s.params));
        const policy = new NeuralBanditPolicy(model, s.options, rng);
        policy.anchor.set(base64ToF64(s.anchor));
        const u = base64ToF64(s.u);
        if (policy.uDiag) {
            if (u.length !== policy.uDiag.length) throw new Error("NeuralTS: serialized U has the wrong size");
            policy.uDiag.set(u);
        } else {
            if (u.length !== policy.uInv!.data.length) throw new Error("NeuralTS: serialized U^-1 has the wrong size");
            policy.uInv!.data.set(u);
        }
        policy.updates = s.updates;
        return policy;
    }
}

export function createNeuralBandit(dim: number, modelType: "mlp" | "fm", options: NeuralBanditOptions, rng: Rng): NeuralBanditPolicy {
    const model: DiffModel = modelType === "fm"
        ? restoreModel("fm", dim, { hidden: options.hidden, fmRank: options.fmRank }, initFm(dim, options.fmRank, rng))
        : new Mlp(dim, options.hidden, rng);
    return new NeuralBanditPolicy(model, options, rng);
}

function initFm(dim: number, rank: number, rng: Rng): Float64Array {
    const p = new Float64Array(1 + dim + dim * rank);
    for (let i = 1 + dim; i < p.length; i++) p[i] = 0.05 * rng.normal();
    return p;
}
