// Off-policy value estimators: what would a new policy pi_e have earned on the traffic a logging policy mu
// actually served?
//
// For logged decisions i = (s_i, a_i, r_i, mu_i = mu(a_i | s_i)) and a target policy pi_e:
//
//   IPS   V = 1/n sum_i  w_i r_i,                       w_i = pi_e(a_i | s_i) / mu_i
//         unbiased whenever mu_i > 0 wherever pi_e > 0 (propensities known exactly - they are logged)
//   SNIPS V = sum_i w_i r_i / sum_i w_i                  self-normalized: slightly biased, much lower variance
//   DM    V = 1/n sum_i  sum_a pi_e(a | s_i) q(s_i, a)   a reward model q; biased exactly as much as q is wrong
//   DR    V = 1/n sum_i [ sum_a pi_e(a | s_i) q(s_i, a) + w_i (r_i - q(s_i, a_i)) ]
//         consistent if EITHER the propensities OR the reward model is correct (Dudik, Langford & Li 2011):
//         a correct q makes the correction term mean-zero, correct propensities cancel q's bias.
//
// `clip` caps w_i (Ionides 2008): lower variance, a known downward bias, reported as such (name suffix).
// Intervals are the normal approximation over the per-decision terms; SNIPS uses the delta method.
import { normalQuantile } from "../math";

export interface LoggedTerm {
    reward: number,
    /** mu(a_i | s_i), the logged propensity */
    loggingPropensity: number,
    /** pi_e(a_i | s_i) */
    targetProbability: number,
    /** q(s_i, a_i) - only for DR */
    qLogged?: number,
    /** sum_a pi_e(a | s_i) q(s_i, a) - only for DM and DR */
    qTarget?: number
}

export interface Estimate {
    name: string,
    value: number,
    stdError: number,
    ciLow: number,
    ciHigh: number,
    n: number,
    /** effective sample size of the importance weights, (sum w)^2 / sum w^2 */
    ess: number,
    maxWeight: number,
    /** how many weights hit the clip */
    clipped: number
}

export interface EstimatorOptions {
    clip?: number,
    confidence?: number
}

function weights(terms: readonly LoggedTerm[], clip: number | undefined): { w: Float64Array, clipped: number, max: number } {
    const w = new Float64Array(terms.length);
    let clipped = 0;
    let max = 0;
    terms.forEach((t, i) => {
        if (!(t.loggingPropensity > 0)) throw new Error("off-policy estimate: a logged propensity is 0 - that decision cannot be re-weighted");
        let wi = t.targetProbability / t.loggingPropensity;
        if (clip !== undefined && wi > clip) {
            wi = clip;
            clipped++;
        }
        w[i] = wi;
        if (wi > max) max = wi;
    });
    return { w, clipped, max };
}

function ess(w: Float64Array): number {
    let s = 0;
    let s2 = 0;
    for (const x of w) {
        s += x;
        s2 += x * x;
    }
    return s2 > 0 ? (s * s) / s2 : 0;
}

function meanEstimate(name: string, values: Float64Array, w: Float64Array, clipped: number, max: number, confidence: number): Estimate {
    const n = values.length;
    let s = 0;
    for (const v of values) s += v;
    const mean = n ? s / n : 0;
    let ss = 0;
    for (const v of values) ss += (v - mean) ** 2;
    const se = n > 1 ? Math.sqrt(ss / (n - 1) / n) : 0;
    const z = normalQuantile(0.5 + confidence / 2);
    return { name, value: mean, stdError: se, ciLow: mean - z * se, ciHigh: mean + z * se, n, ess: ess(w), maxWeight: max, clipped };
}

export function ips(terms: readonly LoggedTerm[], opts: EstimatorOptions = {}): Estimate {
    const { w, clipped, max } = weights(terms, opts.clip);
    const values = Float64Array.from(terms, (t, i) => w[i]! * t.reward);
    return meanEstimate(opts.clip !== undefined ? "ips_clipped" : "ips", values, w, clipped, max, opts.confidence ?? 0.95);
}

export function snips(terms: readonly LoggedTerm[], opts: EstimatorOptions = {}): Estimate {
    const { w, clipped, max } = weights(terms, opts.clip);
    let sw = 0;
    let swr = 0;
    terms.forEach((t, i) => {
        sw += w[i]!;
        swr += w[i]! * t.reward;
    });
    const n = terms.length;
    const value = sw > 0 ? swr / sw : 0;
    // delta method: Var(V) ~ sum w_i^2 (r_i - V)^2 / (sum w_i)^2
    let num = 0;
    terms.forEach((t, i) => {
        num += w[i]! ** 2 * (t.reward - value) ** 2;
    });
    const se = sw > 0 ? Math.sqrt(num) / sw : 0;
    const z = normalQuantile(0.5 + (opts.confidence ?? 0.95) / 2);
    return { name: "snips", value, stdError: se, ciLow: value - z * se, ciHigh: value + z * se, n, ess: ess(w), maxWeight: max, clipped };
}

export function directMethod(terms: readonly LoggedTerm[], opts: EstimatorOptions = {}): Estimate {
    const values = Float64Array.from(terms, (t) => {
        if (t.qTarget === undefined) throw new Error("direct method: qTarget missing");
        return t.qTarget;
    });
    const w = new Float64Array(terms.length).fill(1);
    return meanEstimate("dm", values, w, 0, 1, opts.confidence ?? 0.95);
}

function drTerms(terms: readonly LoggedTerm[], clip: number | undefined) {
    const { w, clipped, max } = weights(terms, clip);
    const values = Float64Array.from(terms, (t, i) => {
        if (t.qTarget === undefined || t.qLogged === undefined) throw new Error("doubly robust: qTarget/qLogged missing");
        return t.qTarget + w[i]! * (t.reward - t.qLogged);
    });
    return { values, w, clipped, max };
}

export function doublyRobust(terms: readonly LoggedTerm[], opts: EstimatorOptions = {}): Estimate {
    const { values, w, clipped, max } = drTerms(terms, opts.clip);
    return meanEstimate(opts.clip !== undefined ? "dr_clipped" : "dr", values, w, clipped, max, opts.confidence ?? 0.95);
}

/**
 * V(target) - V(logging), paired on the same decisions: mean_i [DR_i - r_i]. Both values are estimated on
 * the same traffic, so the noise they share cancels and the interval is far narrower than comparing two
 * separate intervals - this is what the safe-update gate tests.
 */
export function doublyRobustImprovement(terms: readonly LoggedTerm[], opts: EstimatorOptions = {}): Estimate {
    const { values, w, clipped, max } = drTerms(terms, opts.clip);
    const diff = Float64Array.from(values, (v, i) => v - terms[i]!.reward);
    return meanEstimate("dr_improvement", diff, w, clipped, max, opts.confidence ?? 0.95);
}

/** the logging policy's own value: the plain mean of what it earned (on-policy, unbiased) */
export function onPolicyValue(rewards: ArrayLike<number>, confidence = 0.95): Estimate {
    const values = Float64Array.from(rewards as ArrayLike<number>);
    const w = new Float64Array(values.length).fill(1);
    return meanEstimate("logging_policy", values, w, 0, 1, confidence);
}
