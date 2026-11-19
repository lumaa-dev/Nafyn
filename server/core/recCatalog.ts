// the candidate provider behind real mixes: novel suggestions are recordings of the public catalogue (never
// another user's tracks), found and completed through public services.
//
//   recall        ListenBrainz similar recordings of the mode's own tracks (collaborative evidence)
//   graph         ListenBrainz similar artists of the mode's artists + artists co-occurring in the user's
//                 playlists, walked by personalized PageRank
//   collaborative ...plus the artists the user's nearest Nafyn neighbours hold (2+ of them, see recData.ts)
//   enrichment    for the shortlist only: MusicBrainz lookup (release date - unreleased recordings are dropped,
//                 length, credits, album), artist genres, and audio measured from the iTunes preview
import type { IRecording, RecordingIncludes } from "musicbrainz-api";
import { getLibrariesDb } from "./db";
import { previewFeatures } from "./recAudio";
import { artistGenres, artistKeyOf } from "./recData";
import { getMusicBrainzRepository, TRACK_LOOKUP_INC } from "../utils/musicbrainz";
import { withMusicBrainzContext } from "../utils/musicbrainzRepository";
import { pickCanonicalRelease } from "../utils/release";
import { isReleased } from "../utils/releaseDate";
import { coverArchiveUrl } from "../utils/coverUrl";
import { similarArtists, similarRecordings } from "../utils/listenbrainz";
import { ArtistGraph } from "../utils/recommender/mixes/graph";
import type { CandidateProvider, ProviderCandidate, UserTrack } from "../utils/recommender/mixes/pipeline";
import type { ListeningMode } from "../utils/recommender/mixes/modes";
import { audioDbTags, trackTags } from "./recAudioDb";
import { moodFromTag, tagGenres, tagWords } from "../utils/audioDbTags";
import type { TrackInfo } from "../utils/recommender/mixes/types";

const SEEDS_PER_MODE = 10;
const GRAPH_ARTISTS_PER_MODE = 5;

// TheAudioDB lookups the suggestions of one refresh may spend in all (2.1 s apart, see recAudioDb.ts): the cache
// fills over the refreshes, a refresh never waits minutes for it
const CANDIDATE_AUDIODB_LOOKUPS = 12;

/** display fields of a suggestion that TrackInfo does not carry */
export interface SuggestionDisplay {
    artistCredit: string,
    coverArt: string | null,
    /** 0..1, ListenBrainz similarity relative to the strongest in its list */
    popularity: number
}

export class CatalogProvider implements CandidateProvider {
    readonly display = new Map<string, SuggestionDisplay>();
    private readonly graph = new ArtistGraph();
    private graphSeeded = new Set<string>();
    /** TheAudioDB lookups this refresh may still spend on suggestions */
    private audioDbBudget = CANDIDATE_AUDIODB_LOOKUPS;

    constructor(
        private readonly userId: string,
        private readonly tracks: ReadonlyMap<string, UserTrack>,
        private readonly ownedRecordings: ReadonlySet<string>,
        private readonly neighbourArtists: ReadonlyMap<string, number>,
        private readonly maxCandidates: number
    ) {
        // artists sitting in the same playlists as each other, from the user's own playlists
        const byTitle = new Map<string, Set<string>>();
        for (const t of tracks.values()) {
            for (const title of t.doc.playlistTitles) {
                let set = byTitle.get(title);
                if (!set) byTitle.set(title, (set = new Set()));
                set.add(t.info.artistKey);
            }
        }
        for (const artists of byTitle.values()) {
            const list = [...artists].slice(0, 30);
            for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) this.graph.addEdge(list[i]!, list[j]!, 0.5 / list.length);
        }
    }

    private async activeRequestIds(): Promise<Set<string>> {
        const rows = await getLibrariesDb().prepare(`
            SELECT musicbrainzId FROM requests WHERE requestedBy = ? AND status IN ('waiting', 'searching', 'downloading', 'processing')
        `).all<{ musicbrainzId: string }>(this.userId);
        return new Set(rows.map((r) => r.musicbrainzId.toLowerCase()));
    }

    private async seedGraph(mode: ListeningMode): Promise<void> {
        const mbids = new Map<string, string>();
        for (const m of mode.members) {
            const t = this.tracks.get(m.key);
            const mbid = await this.artistMbidOf(m.key);
            if (t && mbid) mbids.set(t.info.artistKey, mbid);
        }
        for (const a of mode.topArtists.slice(0, GRAPH_ARTISTS_PER_MODE)) {
            const mbid = mbids.get(a.key);
            if (!mbid || this.graphSeeded.has(mbid)) continue;
            this.graphSeeded.add(mbid);
            const similar = await similarArtists(mbid);
            const max = Math.max(1, ...similar.map((s) => s.score));
            for (const s of similar.slice(0, 50)) this.graph.addEdge(a.key, artistKeyOf(s.name), s.score / max);
        }
    }

    private artistMbidCache = new Map<string, string | null>();

    private async artistMbidOf(mediaId: string): Promise<string | null> {
        if (this.artistMbidCache.has(mediaId)) return this.artistMbidCache.get(mediaId)!;
        const row = await getLibrariesDb().prepare(`SELECT artistMbid FROM media WHERE id = ?`).get<{ artistMbid: string | null }>(mediaId);
        const id = row?.artistMbid && /^[0-9a-f-]{36}$/i.test(row.artistMbid) ? row.artistMbid.toLowerCase() : null;
        this.artistMbidCache.set(mediaId, id);
        return id;
    }

    async candidatesFor(mode: ListeningMode, exclude: ReadonlySet<string>): Promise<ProviderCandidate[]> {
        const active = await this.activeRequestIds();
        const totalWeight = mode.members.reduce((s, m) => s + m.weight, 0) || 1;
        const found = new Map<string, { candidate: ProviderCandidate, best: number }>();

        const seeds = mode.members.filter((m) => this.tracks.get(m.key)?.info.recordingId).slice(0, SEEDS_PER_MODE);
        for (const seed of seeds) {
            const seedTrack = this.tracks.get(seed.key)!.info;
            const similar = await similarRecordings(seedTrack.recordingId!);
            const max = Math.max(1, ...similar.map((s) => s.score));
            for (const s of similar) {
                const key = `rec:${s.recordingId}`;
                if (this.ownedRecordings.has(s.recordingId) || active.has(s.recordingId) || exclude.has(key)) continue;
                const contribution = (s.score / max) * (seed.weight / totalWeight);
                const artistKey = artistKeyOf(s.artist);
                const entry = found.get(key);
                if (entry) {
                    entry.candidate.collaborative! += contribution;
                    if (contribution > entry.best) {
                        entry.best = contribution;
                        entry.candidate.seedArtist = seedTrack.artistKey !== artistKey ? seedTrack.artists[0] ?? null : null;
                    }
                    continue;
                }
                const track: TrackInfo = {
                    key,
                    recordingId: s.recordingId,
                    title: s.title,
                    artists: [s.artist],
                    artistKey,
                    album: s.release,
                    albumId: null,
                    releaseYear: null,
                    releasedAt: null,
                    durationMs: null,
                    genres: [],
                    audio: null,
                    owned: false
                };
                found.set(key, {
                    best: contribution,
                    candidate: {
                        track,
                        collaborative: contribution,
                        seedArtist: seedTrack.artistKey !== artistKey ? seedTrack.artists[0] ?? null : null,
                        doc: { genres: [], playlistTitles: [], title: s.title, album: s.release, lyrics: null }
                    }
                });
                this.display.set(key, {
                    artistCredit: s.artist,
                    coverArt: s.coverReleaseId ? coverArchiveUrl("release", s.coverReleaseId, 250) : null,
                    popularity: s.score / max
                });
            }
        }

        await this.seedGraph(mode);
        const ppr = this.graph.personalizedPageRank(new Map(mode.topArtists.map((a) => [a.key, a.weight])));
        const neighbourMax = Math.max(1e-9, ...this.neighbourArtists.values());
        return [...found.values()]
            .map(({ candidate }) => {
                const nb = this.neighbourArtists.get(candidate.track.artistKey);
                if (nb) candidate.collaborative = candidate.collaborative! + 0.3 * (nb / neighbourMax) * candidate.collaborative!;
                candidate.graph = ppr.get(candidate.track.artistKey) ?? 0;
                return candidate;
            })
            .sort((a, b) => b.collaborative! - a.collaborative!)
            .slice(0, this.maxCandidates);
    }

    async enrich(list: readonly TrackInfo[]): Promise<Map<string, TrackInfo | null>> {
        const out = new Map<string, TrackInfo | null>();
        const now = Date.now();
        for (const t of list) {
            if (!t.recordingId) continue;
            try {
                const recording: IRecording = await withMusicBrainzContext({ lane: "bulk", key: "recommendations" }, () =>
                    getMusicBrainzRepository().lookup("recording", t.recordingId!, TRACK_LOOKUP_INC as RecordingIncludes[]));
                const release = pickCanonicalRelease(recording.releases);
                const firstDate = (recording as unknown as { "first-release-date"?: string })["first-release-date"] ?? release?.date ?? null;
                // nothing unreleased is ever suggested: it could not be requested (see releaseDate.ts)
                if (firstDate && !isReleased(firstDate, now)) {
                    out.set(t.key, null);
                    continue;
                }
                const credits = recording["artist-credit"] ?? [];
                const artistMbid = credits[0]?.artist?.id ?? null;
                const mbGenres = artistMbid ? (await artistGenres([artistMbid], 1)).get(artistMbid.toLowerCase()) ?? [] : [];
                // TheAudioDB's editors on the album and artist: a genre where MusicBrainz has none, a mood where no
                // preview could be measured, words for the text profile (a small budget: the cache fills over time)
                const albumId = release?.["release-group"]?.id ?? null;
                const budget = Math.min(2, this.audioDbBudget);
                const tagSets = await audioDbTags([{ artistMbid, albumId }], budget);
                this.audioDbBudget -= budget;
                const tags = trackTags(tagSets, artistMbid, albumId);
                const genres = mbGenres.length ? mbGenres : tagGenres(tags);
                const releasedAt = firstDate ? Date.parse(firstDate.length === 4 ? `${firstDate}-01-01` : firstDate.length === 7 ? `${firstDate}-01` : firstDate) : null;
                let audio = t.audio;
                if (!audio) audio = await previewFeatures(t.recordingId).catch(() => null);
                out.set(t.key, {
                    ...t,
                    title: recording.title || t.title,
                    artists: credits.length ? credits.map((c) => c.name) : t.artists,
                    album: release?.title ?? t.album,
                    albumId,
                    releasedAt: releasedAt && Number.isFinite(releasedAt) ? releasedAt : null,
                    releaseYear: releasedAt && Number.isFinite(releasedAt) ? new Date(releasedAt).getUTCFullYear() : null,
                    durationMs: recording.length ?? null,
                    genres,
                    audio,
                    tagMood: moodFromTag(tags.mood),
                    tags: tagWords(tags)
                });
                const display = this.display.get(t.key);
                if (display) {
                    display.artistCredit = credits.map((c) => `${c.name}${c.joinphrase ?? ""}`).join("").trim() || display.artistCredit;
                    if (!display.coverArt && release?.id && release["cover-art-archive"]?.front) display.coverArt = coverArchiveUrl("release", release.id, 250);
                }
            } catch (error) {
                // MusicBrainz busy or the recording gone: leave the candidate as recall described it
                if ((error as { status?: number })?.status === 404) out.set(t.key, null);
            }
        }
        return out;
    }
}
