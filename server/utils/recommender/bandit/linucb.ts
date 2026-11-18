// LinUCB (Li, Chu, Langford & Schapire 2010) over joint context-action features, with one shared parameter
// vector - the "hybrid"-only form: the context is already crossed with the action in the features (see
// features.ts), so a single model generalizes across items, including ones never shown before.
//
//   A = ridge * I + sum_t w_t x_t x_t^T        b = sum_t w_t r_t x_t        theta = A^-1 b
//   r_hat(x) = theta^T x                        sigma(x) = sqrt(x^T A^-1 x)
//   Score(x) = r_hat(x) + lambda * sigma(x)     (lambda = LinUCB's alpha)
//
// A^-1 is maintained incrementally with Sherman-Morrison (O(d^2) per update instead of O(d^3)), and rebuilt
// from A by Cholesky every `refactorEvery` updates: thousands of rank-one updates accumulate rounding error
// and A^-1 slowly stops being the inverse of A (or symmetric, or positive definite). A itself is exact sums.
import {
    type Mat, type Rng, addOuter, axpy, base64ToF64, f64ToBase64, identity, matVec, quadForm, shermanMorrisonUpdate,
    spdInverse, vec
} from "../math";
import { type BanditPolicy, type Prediction, constantLambdas } from "./score";

export interface LinUcbOptions {
    ridge: number,
    lambda: number,
    refactorEvery: number
}

export interface SerializedLinUcb {
    kind: "linucb",
    dim: number,
    ridge: number,
    lambda: number,
    refactorEvery: number,
    updates: number,
    a: string,
    b: string
}

export class LinUcbPolicy implements BanditPolicy {
    readonly kind = "linucb" as const;
    readonly stochastic = false;
    readonly dim: number;
    lambda: number;
    readonly ridge: number;
    private readonly refactorEvery: number;

    private readonly a: Mat;
    private ainv: Mat;
    private readonly b: Float64Array;
    private theta: Float64Array;
    private thetaDirty = false;
    private sinceRefactor = 0;
    updates = 0;

    constructor(dim: number, options: LinUcbOptions) {
        if (!(options.ridge > 0)) throw new Error("LinUCB: ridge must be > 0");
        this.dim = dim;
        this.ridge = options.ridge;
        this.lambda = options.lambda;
        this.refactorEvery = Math.max(1, options.refactorEvery);
        this.a = identity(dim, options.ridge);
        this.ainv = identity(dim, 1 / options.ridge);
        this.b = vec(dim);
        this.theta = vec(dim);
    }

    /** theta = A^-1 b, recomputed only when an update happened since the last read */
    weights(): Float64Array {
        if (this.thetaDirty) {
            this.theta = matVec(this.ainv, this.b);
            this.thetaDirty = false;
        }
        return this.theta;
    }

    /** read-only views, for tests and diagnostics */
    designMatrix(): Mat {
        return this.a;
    }

    inverseDesignMatrix(): Mat {
        return this.ainv;
    }

    predict(xs: readonly Float64Array[]): Prediction {
        const theta = this.weights();
        const n = xs.length;
        const mean = new Float64Array(n);
        const sigma = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const x = xs[i]!;
            if (x.length !== this.dim) throw new Error(`LinUCB: expected ${this.dim} features, got ${x.length}`);
            let m = 0;
            for (let j = 0; j < this.dim; j++) m += theta[j]! * x[j]!;
            mean[i] = m;
            // A^-1 is positive definite, so the quadratic form is >= 0 up to rounding
            sigma[i] = Math.sqrt(Math.max(0, quadForm(this.ainv, x)));
        }
        return { mean, sigma };
    }

    lambdas(n: number, _rng: Rng): Float64Array {
        return constantLambdas(n, this.lambda);
    }

    update(x: Float64Array, reward: number, weight = 1): void {
        if (!(weight > 0) || !Number.isFinite(reward)) return;
        addOuter(this.a, x, weight);
        axpy(this.b, x, weight * reward);
        this.updates++;
        this.sinceRefactor++;
        if (this.sinceRefactor >= this.refactorEvery || !shermanMorrisonUpdate(this.ainv, x, weight)) {
            this.refactor();
        }
        this.thetaDirty = true;
    }

    /** rebuilds A^-1 exactly from A */
    refactor(): void {
        this.ainv = spdInverse(this.a);
        this.sinceRefactor = 0;
        this.thetaDirty = true;
    }

    serialize(): SerializedLinUcb {
        return {
            kind: "linucb",
            dim: this.dim,
            ridge: this.ridge,
            lambda: this.lambda,
            refactorEvery: this.refactorEvery,
            updates: this.updates,
            a: f64ToBase64(this.a.data),
            b: f64ToBase64(this.b)
        };
    }

    static deserialize(s: SerializedLinUcb): LinUcbPolicy {
        const policy = new LinUcbPolicy(s.dim, { ridge: s.ridge, lambda: s.lambda, refactorEvery: s.refactorEvery });
        const a = base64ToF64(s.a);
        const b = base64ToF64(s.b);
        if (a.length !== s.dim * s.dim || b.length !== s.dim) throw new Error("LinUCB: serialized state has the wrong size");
        policy.a.data.set(a);
        policy.b.set(b);
        policy.updates = s.updates;
        policy.refactor();
        return policy;
    }
}
