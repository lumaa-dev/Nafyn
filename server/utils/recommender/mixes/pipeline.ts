// The mixes pipeline end to end, independent of where data comes from: the server feeds it a user's library,
// playlists and plays and a provider backed by ListenBrainz / MusicBrainz / previews; the tests and the
// synthetic demo feed it a generated world. Same code path either way.
//
//   engagements -> affinities -> listening modes (clustering)
//   per mode:  provider recall (collaborative + graph) -> score (all four sources) -> audio shortlist
//              (previews analysed for the best candidates lacking audio) -> re-score -> familiar/novel
//              selection -> flow ordering
//   identities matched to the previous refresh
import type { AudioFeatures } from "./audio";
import { type AssembleConfig, type MixTrackPlan, assembleMix, familiarCandidates, matchToPrevious } from "./assemble";
import { type CandidateEvidence, type Source, modeProfile, scoreCandidates } from "./candidates";
import {
    type AudioStats, type ListeningMode, type ModeConfig, type SignalDims, type TrackAffinity, type TrackSignals,
    computeAffinities, computeAudioStats, discoverModes
} from "./modes";
import { TEXT_DIM, TextIndex, tokenize } from "./text";
import { type Engagement, type MixLabel, type TrackInfo, fallbackTitle } from "./types";

export interface TextDoc {
    /** genres / tags, weighted most */
    genres: string[],
    /** titles of playlists the track is in */
    playlistTitles: string[],
    title: string,
    album: string | null,
    lyrics: string | null
}

export function docFields(doc: TextDoc): { tokens: string[], weight: number }[] {
    return [
        { tokens: doc.genres.flatMap(tokenize), weight: 3 },
        { tokens: doc.playlistTitles.flatMap(tokenize), weight: 2 },
        { tokens: [...tokenize(doc.title), ...tokenize(doc.album ?? "")], weight: 1 },
        { tokens: tokenize(doc.lyrics ?? "").slice(0, 400), weight: 0.5 }
    ];
}

export interface UserTrack {
    info: TrackInfo,
    cf: Float64Array | null,
    embedding: Float64Array | null,
    doc: TextDoc
}

export interface ProviderCandidate extends Omit<CandidateEvidence, "text"> {
    doc: TextDoc
}

export interface CandidateProvider {
    /** recall for one mode: collaborative and graph evidence included, audio when already known */
    candidatesFor(mode: ListeningMode, exclude: ReadonlySet<string>): Promise<ProviderCandidate[]>,
    /**
     * Completes shortlisted candidates (release date, length, artists, measured audio from a preview...).
     * Returns the updated info per key; a key mapped to null is dropped (unreleased, unresolvable).
     */
    enrich(tracks: readonly TrackInfo[]): Promise<Map<string, TrackInfo | null>>
}

export interface MixEngineConfig {
    modes: ModeConfig,
    assemble: AssembleConfig,
    sourceWeights: Record<Source, number>,
    audioShortlist: number,
    minSimilarityToKeepId: number
}

export interface GeneratedMix {
    /** the previous mix this one continues, null when new */
    previousId: string | null,
    label: MixLabel,
    title: string,
    share: number,
    centroid: Float64Array,
    topArtists: ListeningMode["topArtists"],
    tracks: MixTrackPlan[],
    /** info for every track in `tracks` */
    info: Map<string, TrackInfo>
}

export interface MixEngineInput {
    now: number,
    tracks: ReadonlyMap<string, UserTrack>,
    engagements: readonly Engagement[],
    previous: readonly { id: string, centroid: Float64Array }[]
}

export interface MixEngineResult {
    mixes: GeneratedMix[],
    modes: ListeningMode[],
    affinities: Map<string, TrackAffinity>,
    candidatesScored: number
}

export async function generateMixes(input: MixEngineInput, provider: CandidateProvider, cfg: MixEngineConfig): Promise<MixEngineResult> {
    const durations = new Map<string, number | null>([...input.tracks].map(([k, t]) => [k, t.info.durationMs]));
    const affinities = computeAffinities(input.engagements, durations, input.now, cfg.modes.recencyHalfLifeDays);

    // text: IDF over the user's own tracks; candidates are vectorized in the same space
    const index = new TextIndex();
    for (const t of input.tracks.values()) index.add(docFields(t.doc).flatMap((f) => f.tokens));
    const signals = new Map<string, TrackSignals & { text: Float64Array }>();
    for (const [k, t] of input.tracks) signals.set(k, { info: t.info, cf: t.cf, embedding: t.embedding, text: index.vector(docFields(t.doc)) });

    const audioStats: AudioStats | null = computeAudioStats([...input.tracks.values()].map((t) => t.info.audio).filter((a): a is AudioFeatures => !!a));
    const first = [...input.tracks.values()][0];
    const dims: SignalDims = { cf: first?.cf?.length ?? 0, embedding: first?.embedding?.length ?? 0, text: TEXT_DIM };
    for (const t of input.tracks.values()) {
        dims.cf = Math.max(dims.cf, t.cf?.length ?? 0);
        dims.embedding = Math.max(dims.embedding, t.embedding?.length ?? 0);
    }

    const modes = discoverModes({ tracks: signals, affinities, audioStats, dims }, cfg.modes);
    const ids = matchToPrevious(input.previous, modes.map((m) => m.centroid), cfg.minSimilarityToKeepId);
    const owned = new Set([...input.tracks.values()].filter((t) => t.info.owned).map((t) => t.info.key));
    // a suggestion appears in at most one mix (the best-fitting mode gets it, modes in share order)
    const alreadySuggested = new Set<string>();
    let candidatesScored = 0;

    const mixes: GeneratedMix[] = [];
    for (const [m, mode] of modes.entries()) {
        const profile = modeProfile(mode, signals, audioStats);
        const recalled = await provider.candidatesFor(mode, new Set([...owned, ...alreadySuggested]));
        const fresh = recalled.filter((c) => !owned.has(c.track.key) && !alreadySuggested.has(c.track.key));
        const docs = new Map(fresh.map((c) => [c.track.key, c.doc]));
        const evidence: CandidateEvidence[] = fresh
            .map((c) => ({ track: c.track, collaborative: c.collaborative, graph: c.graph, seedArtist: c.seedArtist, text: index.vector(docFields(c.doc)) }));

        let scored = scoreCandidates(mode, profile, evidence, audioStats, cfg.sourceWeights);
        // the shortlist is completed (metadata, a preview's measured audio) - the expensive part, so only for
        // the best candidates - then everything is scored again with what was learned
        const shortlist = scored.slice(0, cfg.audioShortlist).map((s) => s.evidence.track);
        if (shortlist.length) {
            const enriched = await provider.enrich(shortlist);
            const dropped = new Set([...enriched].filter(([, t]) => t === null).map(([k]) => k));
            for (const e of evidence) {
                const t = enriched.get(e.track.key);
                if (!t) continue;
                e.track = t;
                // enrichment can bring genres the recall step did not know: the text profile follows
                const doc = docs.get(t.key);
                if (doc && t.genres.length) e.text = index.vector(docFields({ ...doc, genres: t.genres }));
            }
            scored = scoreCandidates(mode, profile, evidence.filter((e) => !dropped.has(e.track.key)), audioStats, cfg.sourceWeights);
        }
        candidatesScored += scored.length;

        const info = new Map<string, TrackInfo>();
        for (const [k, s] of signals) info.set(k, s.info);
        for (const s of scored) info.set(s.evidence.track.key, s.evidence.track);
        const plan = assembleMix(familiarCandidates(mode, affinities, input.now), scored, info, cfg.assemble);
        for (const t of plan) if (!t.familiar) alreadySuggested.add(t.key);

        const used = new Map<string, TrackInfo>();
        for (const t of plan) used.set(t.key, info.get(t.key)!);
        mixes.push({
            previousId: ids[m] ?? null,
            label: mode.label,
            title: fallbackTitle(mode.label),
            share: mode.share,
            centroid: mode.centroid,
            topArtists: mode.topArtists,
            tracks: plan,
            info: used
        });
    }
    return { mixes, modes, affinities, candidatesScored };
}

