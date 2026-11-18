// The one scoring rule every bandit policy in Nafyn goes through:
//
//     Score(s, a) = r_hat(s, a) + lambda * sigma(s, a)
//
//   r_hat  - predicted expected reward of action a in context s (LinUCB's ridge regression, or a neural /
//            factorization-machine model)
//   sigma  - the uncertainty of that prediction (LinUCB: the closed-form confidence width sqrt(x^T A^-1 x);
//            neural: sqrt(ridge * g^T U^-1 g / m) over the network gradient g)
//   lambda - the exploration coefficient. A constant for the UCB policies (LinUCB, NeuralUCB). For Neural
//            Thompson Sampling it is drawn per arm from N(0, nu^2): then r_hat + lambda * sigma is exactly a
//            draw from the posterior N(r_hat, nu^2 sigma^2) that Thompson sampling ranks by - the formula is
//            the same, only lambda is random.
import type { Rng } from "../math";

export function explorationScore(rHat: number, sigma: number, lambda: number): number {
    return rHat + lambda * sigma;
}

export interface Prediction {
    /** r_hat per candidate */
    mean: Float64Array,
    /** sigma per candidate, >= 0 */
    sigma: Float64Array
}

export interface ScoredActions extends Prediction {
    /** the lambda each candidate was scored with */
    lambda: Float64Array,
    /** Score = mean + lambda * sigma */
    score: Float64Array
}

export type PolicyKind = "linucb" | "neural_ts" | "neural_ucb";

/** A contextual bandit policy over joint context-action feature vectors. */
export interface BanditPolicy {
    readonly kind: PolicyKind,
    /** length of the joint feature vector this policy scores */
    readonly dim: number,
    /** true when lambda is random (Thompson sampling): the propensity of a choice then has to be estimated */
    readonly stochastic: boolean,
    /** stochastic policies: the scale of lambda ~ N(0, nu^2) */
    readonly nu?: number,
    predict(xs: readonly Float64Array[]): Prediction,
    /** the exploration coefficients for one scoring pass over n candidates */
    lambdas(n: number, rng: Rng): Float64Array,
    /** one observed (features, reward), with a sample weight (the reward's confidence) */
    update(x: Float64Array, reward: number, weight?: number): void
}

/** scores every candidate with the formula above */
export function scoreActions(policy: BanditPolicy, xs: readonly Float64Array[], rng: Rng): ScoredActions {
    const { mean, sigma } = policy.predict(xs);
    const lambda = policy.lambdas(xs.length, rng);
    const score = new Float64Array(xs.length);
    for (let i = 0; i < xs.length; i++) score[i] = explorationScore(mean[i]!, sigma[i]!, lambda[i]!);
    return { mean, sigma, lambda, score };
}

/** constant lambda, for the UCB policies */
export function constantLambdas(n: number, lambda: number): Float64Array {
    return new Float64Array(n).fill(lambda);
}

/** lambda_i ~ N(0, nu^2), for Thompson sampling */
export function gaussianLambdas(n: number, nu: number, rng: Rng): Float64Array {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = nu * rng.normal();
    return out;
}
