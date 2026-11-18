// Natural-language signals: lyrics, playlist titles a track sits in, MusicBrainz genres/tags, titles.
//
// TF-IDF over a hashed vocabulary (the "hashing trick"): no vocabulary to store or keep in sync between
// processes, a fixed dimension, and new words cost nothing. Accents are folded, so "électro" and "electro"
// meet; stopwords of the two interface languages are dropped.
import { hashString } from "../math";

export const TEXT_DIM = 512;

const STOPWORDS = new Set([
    // en
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "it", "my", "your", "you", "me",
    "i", "we", "be", "at", "by", "this", "that", "from", "are", "was", "so", "but", "not", "no", "oh", "yeah",
    "feat", "ft", "remaster", "remastered", "version", "edit", "mix",
    // fr
    "le", "la", "les", "un", "une", "des", "et", "ou", "de", "du", "en", "au", "aux", "pour", "avec", "est", "je",
    "tu", "il", "elle", "nous", "vous", "ils", "mon", "ma", "mes", "ton", "ta", "tes", "ce", "cette", "que", "qui"
]);

export function tokenize(text: string): string[] {
    return text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** document frequencies over a corpus, for IDF */
export class TextIndex {
    private readonly df = new Float64Array(TEXT_DIM);
    private docs = 0;

    add(tokens: readonly string[]): void {
        const seen = new Set<number>();
        for (const t of tokens) seen.add(hashString(t) % TEXT_DIM);
        for (const h of seen) this.df[h]! += 1;
        this.docs++;
    }

    idf(h: number): number {
        return Math.log((1 + this.docs) / (1 + this.df[h]!)) + 1;
    }

    /** L2-normalized TF-IDF vector; `weight` lets one field (genres) count more than another (lyrics) */
    vector(fields: readonly { tokens: readonly string[], weight: number }[]): Float64Array {
        const v = new Float64Array(TEXT_DIM);
        for (const { tokens, weight } of fields) {
            if (tokens.length === 0) continue;
            const tf = new Map<number, number>();
            for (const t of tokens) {
                const h = hashString(t) % TEXT_DIM;
                tf.set(h, (tf.get(h) ?? 0) + 1);
            }
            for (const [h, c] of tf) v[h]! += weight * (1 + Math.log(c)) * this.idf(h);
        }
        let n = 0;
        for (const x of v) n += x * x;
        n = Math.sqrt(n);
        if (n > 0) for (let i = 0; i < TEXT_DIM; i++) v[i]! /= n;
        return v;
    }
}
