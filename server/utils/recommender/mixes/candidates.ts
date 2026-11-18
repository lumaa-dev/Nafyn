// Candidate scoring for a mode: four independent sources of evidence that a recording fits it, fused.
//
//   collaborative - listeners with similar patterns: ListenBrainz' session-based similar recordings of the
//                   mode's own tracks (collaborative filtering over its whole listener base), plus how much the
//                   Nafyn users most similar to this one (ALS neighbours) like the candidate's artist
//   audio         - closeness of the candidate's measured descriptors (its preview) to the mode's audio profile
//   text          - TF-IDF similarity of genres/tags/titles to the mode's text profile (genres, playlist titles,
//                   lyrics of its tracks)
//   graph         - personalized PageRank of the candidate's artist from the mode's artists on the artist graph
//
// Raw scores live on incomparable scales, so each source is rank-normalized within the candidate set
// (percentile in [0, 1]) before the weighted sum. A source that has nothing to say about a candidate (no
// preview to analyse, say) is left out of that candidate's sum and the weights renormalized, with a mild
// coverage penalty - missing evidence is not negative evidence, but agreement of several sources is worth more.
//
// Hard gates keep a mix what its title says: a decade mix only takes that decade, a genre mix only takes
// candidates whose genres (or text profile) belong to that genre.
import { cosine } from "../math";
import type { AudioFeatures } from "./audio";
import { type AudioStats, type ListeningMode, zAudio } from "./modes";
import { type TrackInfo, decadeOf, moodOf } from "./types";

export const SOURCES = ["collaborative", "audio", "text", "graph"] as const;
export type Source = (typeof SOURCES)[number];

export interface CandidateEvidence {
    track: TrackInfo,
    collaborative?: number,
    graph?: number,
    /** the candidate's TF-IDF vector (same TextIndex as the mode's) */
    text?: Float64Array,
    /** the user's artist this candidate was found through */
    seedArtist: string | null
}

export interface ModeProfile {
    audioMean: number[] | null,
    audioStd: number[] | null,
    text: Float64Array | null
}

/** the mode's audio and text profile, from its members (weighted) */
export function modeProfile(mode: ListeningMode, tracks: ReadonlyMap<string, { info: TrackInfo, text: Float64Array | null }>, stats: AudioStats | null): ModeProfile {
    const audio: { v: number[], w: number }[] = [];
    let text: Float64Array | null = null;
    for (const m of mode.members) {
        const t = tracks.get(m.key);
        if (!t) continue;
        if (t.info.audio && stats) audio.push({ v: zAudio(t.info.audio, stats), w: m.weight });
        if (t.text) {
            text ??= new Float64Array(t.text.length);
            for (let i = 0; i < text.length; i++) text[i]! += m.weight * t.text[i]!;
        }
    }
    let audioMean: number[] | null = null;
    let audioStd: number[] | null = null;
    if (audio.length >= 2) {
        const W = audio.reduce((s, a) => s + a.w, 0);
        const d = audio[0]!.v.length;
        audioMean = Array.from({ length: d }, (_, j) => audio.reduce((s, a) => s + a.w * a.v[j]!, 0) / W);
        // floor the spread: a tight cluster must not reject everything a hair outside it
        audioStd = Array.from({ length: d }, (_, j) => Math.max(0.35, Math.sqrt(audio.reduce((s, a) => s + a.w * (a.v[j]! - audioMean![j]!) ** 2, 0) / W)));
    }
    return { audioMean, audioStd, text };
}

/** Gaussian closeness in the mode's own standardized space, in (0, 1] */
export function audioFit(audio: AudioFeatures, profile: ModeProfile, stats: AudioStats | null): number | null {
    if (!profile.audioMean || !profile.audioStd || !stats) return null;
    const z = zAudio(audio, stats);
    let s = 0;
    for (let j = 0; j < z.length; j++) s += ((z[j]! - profile.audioMean[j]!) / profile.audioStd[j]!) ** 2;
    return Math.exp(-0.5 * (s / z.length));
}

/** fraction of values strictly below each value, ties averaged: rank percentile in [0, 1] */
export function rankNormalize(values: readonly (number | undefined)[]): (number | undefined)[] {
    const present = values.map((v, i) => [v, i] as const).filter(([v]) => v !== undefined && Number.isFinite(v)) as [number, number][];
    const out: (number | undefined)[] = new Array(values.length).fill(undefined);
    if (present.length === 0) return out;
    if (present.length === 1) {
        out[present[0]![1]] = 1;
        return out;
    }
    present.sort((a, b) => a[0] - b[0]);
    let i = 0;
    while (i < present.length) {
        let j = i;
        while (j + 1 < present.length && present[j + 1]![0] === present[i]![0]) j++;
        const rank = (i + j) / 2 / (present.length - 1);
        for (let k = i; k <= j; k++) out[present[k]![1]] = rank;
        i = j + 1;
    }
    return out;
}

export interface ScoredCandidate {
    evidence: CandidateEvidence,
    fit: number,
    sources: Record<Source, number | null>,
    /** the source that contributed most - what the explanation names */
    dominant: Source
}

/** does the candidate belong in a mix with this label? */
export function passesGate(mode: ListeningMode, t: TrackInfo, profileText: Float64Array | null, text?: Float64Array): boolean {
    const label = mode.label;
    const checks = [label, ...(label.qualifier ? [label.qualifier] : [])];
    for (const c of checks) {
        switch (c.kind) {
            case "decade": {
                const d = decadeOf(t.releaseYear);
                if (d !== null && d !== c.value) return false;
                break;
            }
            case "genre": {
                if (t.genres.length) {
                    if (!t.genres.slice(0, 4).includes(c.value)) return false;
                } else if (profileText && text && cosine(profileText, text) < 0.15) {
                    return false;
                }
                break;
            }
            case "mood": {
                const m = moodOf(t.audio);
                if (m !== null && m !== c.value) return false;
                break;
            }
            default:
                break;
        }
    }
    return true;
}

export function scoreCandidates(
    mode: ListeningMode,
    profile: ModeProfile,
    candidates: readonly CandidateEvidence[],
    stats: AudioStats | null,
    weights: Readonly<Record<Source, number>>
): ScoredCandidate[] {
    const gated = candidates.filter((c) => !c.track.owned && passesGate(mode, c.track, profile.text, c.text));
    const raw: Record<Source, (number | undefined)[]> = {
        collaborative: gated.map((c) => c.collaborative),
        graph: gated.map((c) => c.graph),
        text: gated.map((c) => (c.text && profile.text ? cosine(c.text, profile.text) : undefined)),
        audio: gated.map((c) => (c.track.audio ? audioFit(c.track.audio, profile, stats) ?? undefined : undefined))
    };
    const norm = Object.fromEntries(SOURCES.map((s) => [s, rankNormalize(raw[s])])) as Record<Source, (number | undefined)[]>;

    return gated.map((evidence, i) => {
        let num = 0;
        let den = 0;
        let present = 0;
        let dominant: Source = "collaborative";
        let dominantValue = -Infinity;
        const sources = {} as Record<Source, number | null>;
        for (const s of SOURCES) {
            const v = norm[s][i];
            sources[s] = v ?? null;
            if (v === undefined) continue;
            num += weights[s] * v;
            den += weights[s];
            present++;
            if (weights[s] * v > dominantValue) {
                dominantValue = weights[s] * v;
                dominant = s;
            }
        }
        const coverage = present / SOURCES.length;
        const fit = den > 0 ? (num / den) * Math.pow(coverage, 0.25) : 0;
        return { evidence, fit, sources, dominant };
    }).sort((a, b) => b.fit - a.fit || a.evidence.track.key.localeCompare(b.evidence.track.key));
}
