// Similarity between two normalized texts, in every script.
//
//  - Latin/Cyrillic/Greek (and any other spaced script): word tokens, each compared with typo tolerance.
//  - CJK (no spaces): character n-grams and a Dice coefficient.
//
// The title score is a *containment* score, not a symmetric fuzzy ratio: coverage of what was asked for,
// multiplied by a penalty for every distinctive word the candidate adds. A set-ratio would score
// "Led Zeppelin" and "Led Zeppelin II" as identical, because it ignores extra words.

import type { SearchConfig } from "./config";
import type { NormalizedText } from "./normalize";

export function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    const left = Array.from(a);
    const right = Array.from(b);
    if (left.length === 0) return right.length;
    if (right.length === 0) return left.length;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        const current = [i];
        for (let j = 1; j <= right.length; j++) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
        }
        previous = current;
    }
    return previous[right.length]!;
}

/** 1 - distance / longest length: 1 for identical strings, 0 for nothing in common. */
export function levenshteinRatio(a: string, b: string): number {
    const longest = Math.max(Array.from(a).length, Array.from(b).length);
    if (longest === 0) return 1;
    return 1 - levenshtein(a, b) / longest;
}

const HAS_DIGIT = /\p{N}/u;

export function wordsMatch(a: string, b: string, config: SearchConfig): number {
    if (a === b) return 1;
    // a number is never "a typo" of another number
    if (HAS_DIGIT.test(a) || HAS_DIGIT.test(b)) return 0;
    if (Math.min(Array.from(a).length, Array.from(b).length) < config.typoMinLength) return 0;
    const ratio = levenshteinRatio(a, b);
    return ratio >= config.tokenTypoRatio ? ratio : 0;
}

export interface WordAlignment {
    matched: number,
    /** Sum of the match strengths (1 for exact, the ratio for a typo) */
    strength: number,
    missing: string[],
    extra: string[]
}

// greedy best-pair assignment, each candidate word used at most once
export function alignWords(requested: string[], candidate: string[], config: SearchConfig): WordAlignment {
    const pairs: Array<{ r: number, c: number, strength: number }> = [];
    for (let r = 0; r < requested.length; r++) {
        for (let c = 0; c < candidate.length; c++) {
            const strength = wordsMatch(requested[r]!, candidate[c]!, config);
            if (strength > 0) pairs.push({ r, c, strength });
        }
    }
    pairs.sort((x, y) => y.strength - x.strength);

    const usedR = new Set<number>();
    const usedC = new Set<number>();
    let strength = 0;
    for (const pair of pairs) {
        if (usedR.has(pair.r) || usedC.has(pair.c)) continue;
        usedR.add(pair.r);
        usedC.add(pair.c);
        strength += pair.strength;
    }

    return {
        matched: usedR.size,
        strength,
        missing: requested.filter((_, index) => !usedR.has(index)),
        extra: candidate.filter((_, index) => !usedC.has(index))
    };
}

// ---------------------------------------------------------------- CJK

/** Bigrams, or unigrams when either side is so short that a bigram would be the whole string. */
export function gramSize(a: string, b: string): 1 | 2 {
    return Math.min(Array.from(a).length, Array.from(b).length) <= 2 ? 1 : 2;
}

export function grams(text: string, size: 1 | 2): string[] {
    const chars = Array.from(text);
    if (size === 1) return chars;
    const out: string[] = [];
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
    return out;
}

function multisetIntersection(a: string[], b: string[]): number {
    const counts = new Map<string, number>();
    for (const gram of a) counts.set(gram, (counts.get(gram) ?? 0) + 1);
    let shared = 0;
    for (const gram of b) {
        const left = counts.get(gram) ?? 0;
        if (left > 0) {
            counts.set(gram, left - 1);
            shared++;
        }
    }
    return shared;
}

export interface CjkComparison {
    dice: number,
    /** Share of the requested grams the candidate has. */
    coverage: number,
    /** Share of the candidate's grams the request has. */
    candidateCoverage: number,
    /** Candidate characters the request did not ask for. */
    extraChars: number
}

export function compareCjk(requested: string, candidate: string): CjkComparison {
    if (!requested || !candidate) return { dice: 0, coverage: 0, candidateCoverage: 0, extraChars: Array.from(candidate).length };
    const size = gramSize(requested, candidate);
    const r = grams(requested, size);
    const c = grams(candidate, size);
    const shared = multisetIntersection(r, c);
    const dice = r.length + c.length === 0 ? 0 : (2 * shared) / (r.length + c.length);

    // characters of the candidate covered by a shared gram; the rest were not asked for
    const requestedGrams = new Map<string, number>();
    for (const gram of r) requestedGrams.set(gram, (requestedGrams.get(gram) ?? 0) + 1);
    const candidateChars = Array.from(candidate);
    const covered = new Set<number>();
    for (let i = 0; i + size <= candidateChars.length; i++) {
        const gram = candidateChars.slice(i, i + size).join("");
        const left = requestedGrams.get(gram) ?? 0;
        if (left > 0) {
            requestedGrams.set(gram, left - 1);
            for (let k = 0; k < size; k++) covered.add(i + k);
        }
    }

    return {
        dice,
        coverage: r.length === 0 ? 0 : shared / r.length,
        candidateCoverage: c.length === 0 ? 0 : shared / c.length,
        extraChars: candidateChars.length - covered.size
    };
}

// ---------------------------------------------------------------- combined

export interface Comparison {
    /** Share of the requested units (words, CJK grams) found in the candidate. 1 when nothing was requested. */
    coverage: number,
    /** Share of the candidate's units found in the request. */
    candidateCoverage: number,
    /** Distinctive candidate words the request does not have. */
    extraWords: string[],
    extraChars: number,
    /** Distinctive request words the candidate lacks. */
    missingWords: string[],
    /** Weighted blend of the CJK Dice and the word coverage, used as the similarity of a *name*. */
    dice: number
}

export function compareNormalized(requested: NormalizedText, candidate: NormalizedText, config: SearchConfig): Comparison {
    const wordsRequested = requested.distinctive;
    const wordsCandidate = candidate.distinctive;
    const haveWords = wordsRequested.length > 0;
    const haveCjk = requested.cjk.length > 0;

    const alignment = alignWords(wordsRequested, wordsCandidate, config);
    const cjk = compareCjk(requested.cjk, candidate.cjk);

    const wordUnits = wordsRequested.length;
    const cjkUnits = Math.max(1, Math.ceil(Array.from(requested.cjk).length / 2));

    let coverage: number;
    if (haveWords && haveCjk) {
        const wordCoverage = alignment.strength / wordUnits;
        coverage = (wordCoverage * wordUnits + cjk.coverage * cjkUnits) / (wordUnits + cjkUnits);
    } else if (haveWords) coverage = alignment.strength / wordUnits;
    else if (haveCjk) coverage = cjk.coverage;
    else coverage = 1;

    const candidateWordUnits = wordsCandidate.length;
    const candidateCjkUnits = candidate.cjk.length > 0 ? Math.max(1, Math.ceil(Array.from(candidate.cjk).length / 2)) : 0;
    const candidateUnits = candidateWordUnits + candidateCjkUnits;
    const candidateCoverage = candidateUnits === 0
        ? 1
        : (alignment.strength + cjk.candidateCoverage * candidateCjkUnits) / candidateUnits;

    // the candidate's words/characters are only "extra" in a script the request actually used for them:
    // a Latin-only request against a CJK-only candidate is a script mismatch, scored by coverage, not by extras
    return {
        coverage,
        candidateCoverage,
        extraWords: alignment.extra,
        extraChars: haveCjk ? cjk.extraChars : candidate.cjk.length === 0 ? 0 : Array.from(candidate.cjk).length,
        missingWords: alignment.missing,
        dice: haveCjk && !haveWords ? cjk.dice : coverage
    };
}

/**
 * Containment score: what was asked for must be there, and every extra distinctive word costs.
 * A request without a title scores 1 (neutral).
 */
export function titleScore(requested: NormalizedText, candidate: NormalizedText, config: SearchConfig): { score: number, comparison: Comparison } {
    const comparison = compareNormalized(requested, candidate, config);
    if (requested.distinctive.length === 0 && requested.cjk.length === 0) return { score: 1, comparison };

    let score = comparison.coverage * Math.pow(config.extraTokenPenalty, comparison.extraWords.length);
    if (requested.cjk.length > 0 && requested.distinctive.length === 0) {
        // CJK has no word boundaries: the Dice coefficient already charges for extra characters
        score = comparison.dice;
    } else if (requested.cjk.length > 0) {
        score *= Math.pow(config.extraTokenPenalty, Math.floor(comparison.extraChars / 2));
    }
    return { score: Math.max(0, Math.min(1, score)), comparison };
}

/** How alike two *names* are, order-insensitive ("Callas, Maria" == "Maria Callas"). */
export function nameSimilarity(requested: NormalizedText, candidate: NormalizedText, config: SearchConfig): number {
    if (requested.distinctive.length === 0 && requested.cjk.length === 0) return 1;
    const comparison = compareNormalized(requested, candidate, config);
    if (requested.cjk.length > 0 && requested.distinctive.length === 0) return comparison.dice;
    // asking for the surname of a full name is fine, asking for a full name and getting a surname is worse
    return Math.min(1, 0.7 * comparison.coverage + 0.3 * comparison.candidateCoverage);
}

/** Title exactness for the ranking tie-break: Levenshtein ratio over the full normalized strings. */
export function exactness(requested: NormalizedText, candidate: NormalizedText): number {
    return levenshteinRatio(requested.text, candidate.text);
}
