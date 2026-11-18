// A synthetic music world with known ground truth, for the tests, `bun run rec:demo` and the offline
// evaluation demo. Nothing here is used in production.
//
//   catalog  - genres with audio prototypes, artists with eras, tracks with measured-looking audio features
//   users    - each with 2-5 true listening modes (genre, optional decade, preferred time of day, weight)
//   history  - sessions over ~4 months: streams (with realistic heard durations), early skips, saves,
//              playlist adds into titled playlists
//   services - stand-ins for ListenBrainz similar recordings / similar artists, derived from the truth plus noise
//   bandit   - a home page environment whose reward probabilities p(s, a) are known exactly, so the true value of
//              any policy can be computed and compared with what IPS / DR estimate from logs
import { Rng, clamp, sigmoid } from "./math";
import type { AudioFeatures } from "./mixes/audio";
import { TIMBRE_DIM } from "./mixes/audio";
import type { CandidateProvider, ProviderCandidate, TextDoc, UserTrack } from "./mixes/pipeline";
import { ArtistGraph } from "./mixes/graph";
import type { ListeningMode } from "./mixes/modes";
import type { Engagement, TrackInfo } from "./mixes/types";
import {
    type ActionInput, type ContextInput, type Device, type ExplanationKind, type ItemKind, type ShelfKind,
    AUDIO_SUMMARY_DIM, DEVICES, ITEM_KINDS, SHELF_KINDS, USER_EMBEDDING_DIM, encodeAction
} from "./bandit/features";
import type { CardCandidate, ShelfCandidate } from "./bandit/hierarchical";

interface GenreSpec {
    name: string,
    energy: number,
    valence: number,
    tempo: number,
    danceability: number,
    acousticness: number,
    brightness: number,
    words: string[]
}

const GENRES: GenreSpec[] = [
    { name: "ambient", energy: 0.15, valence: 0.35, tempo: 80, danceability: 0.2, acousticness: 0.7, brightness: 0.25, words: ["drift", "calm", "space", "night"] },
    { name: "techno", energy: 0.85, valence: 0.4, tempo: 128, danceability: 0.85, acousticness: 0.05, brightness: 0.6, words: ["warehouse", "pulse", "machine", "rave"] },
    { name: "jazz", energy: 0.35, valence: 0.6, tempo: 110, danceability: 0.5, acousticness: 0.8, brightness: 0.35, words: ["smoke", "blue", "swing", "late"] },
    { name: "metal", energy: 0.95, valence: 0.2, tempo: 150, danceability: 0.3, acousticness: 0.02, brightness: 0.75, words: ["iron", "fire", "storm", "riff"] },
    { name: "pop", energy: 0.7, valence: 0.8, tempo: 118, danceability: 0.75, acousticness: 0.2, brightness: 0.55, words: ["summer", "love", "dance", "heart"] },
    { name: "folk", energy: 0.3, valence: 0.45, tempo: 95, danceability: 0.35, acousticness: 0.9, brightness: 0.3, words: ["river", "home", "road", "wood"] },
    { name: "hip hop", energy: 0.65, valence: 0.5, tempo: 92, danceability: 0.8, acousticness: 0.1, brightness: 0.45, words: ["street", "flow", "city", "crew"] },
    { name: "classical", energy: 0.25, valence: 0.4, tempo: 100, danceability: 0.15, acousticness: 0.95, brightness: 0.3, words: ["sonata", "concerto", "adagio", "opus"] }
];
const DECADES = [1970, 1980, 1990, 2000, 2010, 2020];
const PLAYLIST_TEMPLATES = ["{w} vibes", "my {g}", "{g} for the {t}", "{w} {w2}", "best of {g}"];

export interface SyntheticMode {
    genre: number,
    decade: number | null,
    /** 0 night, 1 morning, 2 afternoon, 3 evening */
    hourBin: number,
    weight: number
}

export interface SyntheticUser {
    id: string,
    modes: SyntheticMode[],
    taste: Float64Array
}

export interface SyntheticWorld {
    rng: Rng,
    tracks: TrackInfo[],
    trackGenre: Map<string, number>,
    trackLatent: Map<string, Float64Array>,
    artistNames: string[],
    artistGenre: number[],
    users: SyntheticUser[],
    owned: Map<string, Set<string>>,
    engagements: Map<string, Engagement[]>,
    playlists: { owner: string, title: string, tracks: string[] }[],
    now: number
}

const DAY = 86_400_000;

function audioFor(g: GenreSpec, rng: Rng, artistShift: number[]): AudioFeatures {
    const n = (x: number, s: number) => clamp(x + s * rng.normal(), 0, 1);
    const valence = n(g.valence + artistShift[1]!, 0.12);
    return {
        tempo: Math.max(55, g.tempo * (1 + 0.06 * rng.normal()) + artistShift[2]! * 10),
        key: rng.int(12),
        mode: rng.next() < 0.3 + 0.5 * valence ? 1 : 0,
        loudness: -14 + 10 * g.energy + 2 * rng.normal(),
        energy: n(g.energy + artistShift[0]!, 0.1),
        valence,
        danceability: n(g.danceability, 0.1),
        acousticness: n(g.acousticness, 0.08),
        brightness: n(g.brightness, 0.07),
        timbre: Array.from({ length: TIMBRE_DIM }, (_, i) => Math.sin((GENRES.indexOf(g) + 1) * (i + 1)) + 0.2 * rng.normal())
    };
}

export function generateWorld(seed = 7, opts: { artists?: number, tracksPerArtist?: number, users?: number } = {}): SyntheticWorld {
    const rng = new Rng(seed);
    const nArtists = opts.artists ?? 120;
    const perArtist = opts.tracksPerArtist ?? 8;
    const now = Date.UTC(2026, 10, 18);
    const tracks: TrackInfo[] = [];
    const trackGenre = new Map<string, number>();
    const trackLatent = new Map<string, Float64Array>();
    const artistNames: string[] = [];
    const artistGenre: number[] = [];

    for (let a = 0; a < nArtists; a++) {
        const g = a % GENRES.length;
        const spec = GENRES[g]!;
        const era = DECADES[rng.int(DECADES.length)]!;
        const shift = [0.08 * rng.normal(), 0.08 * rng.normal(), rng.normal()];
        const latent = Float64Array.from({ length: 8 }, (_, i) => (i === g ? 1 : 0) + 0.3 * rng.normal());
        const name = `${spec.words[a % spec.words.length]!.replace(/^./, (c) => c.toUpperCase())} ${["Collective", "Ensemble", "Kids", "Machine", "Band", "Project"][a % 6]} ${a}`;
        artistNames.push(name);
        artistGenre.push(g);
        for (let t = 0; t < perArtist; t++) {
            const key = `t${a}-${t}`;
            const year = era + rng.int(10);
            tracks.push({
                key,
                recordingId: null,
                title: `${spec.words[rng.int(spec.words.length)]} ${spec.words[rng.int(spec.words.length)]} ${t}`,
                artists: [name],
                artistKey: `artist-${a}`,
                album: `${name} LP`,
                albumId: `album-${a}-${Math.floor(t / 4)}`,
                releaseYear: year,
                releasedAt: Date.UTC(year, rng.int(12), 1),
                durationMs: 150_000 + rng.int(150_000),
                genres: [spec.name],
                audio: audioFor(spec, rng, shift),
                owned: false
            });
            trackGenre.set(key, g);
            trackLatent.set(key, Float64Array.from(latent, (x) => x + 0.15 * rng.normal()));
        }
    }

    const users: SyntheticUser[] = [];
    const owned = new Map<string, Set<string>>();
    const engagements = new Map<string, Engagement[]>();
    const playlists: SyntheticWorld["playlists"] = [];
    const byGenre = GENRES.map((_, g) => tracks.filter((t) => trackGenre.get(t.key) === g));

    for (let u = 0; u < (opts.users ?? 24); u++) {
        const id = `user-${u}`;
        const nModes = 2 + rng.int(4);
        const genres = rng.shuffle(GENRES.map((_, i) => i)).slice(0, nModes);
        const weights = genres.map(() => rng.gamma(2));
        const wsum = weights.reduce((s, x) => s + x, 0);
        const modes: SyntheticMode[] = genres.map((g, i) => ({
            genre: g,
            decade: rng.next() < 0.3 ? DECADES[rng.int(DECADES.length)]! : null,
            hourBin: rng.int(4),
            weight: weights[i]! / wsum
        }));
        const taste = new Float64Array(8);
        for (const m of modes) taste[m.genre]! += m.weight;
        users.push({ id, modes, taste });

        // the library: per mode, tracks of its genre (and decade), favourites first
        const lib = new Set<string>();
        const modeTracks = modes.map((m) => {
            const pool = byGenre[m.genre]!.filter((t) => m.decade === null || (t.releaseYear! >= m.decade && t.releaseYear! < m.decade + 10));
            const source = pool.length >= 10 ? pool : byGenre[m.genre]!;
            const n = Math.min(source.length, 10 + Math.round(40 * m.weight));
            const chosen = rng.shuffle([...source]).slice(0, n);
            for (const t of chosen) lib.add(t.key);
            return chosen;
        });
        owned.set(id, lib);

        const events: Engagement[] = [];
        const days = 120;
        modes.forEach((m, mi) => {
            // a titled playlist per mode
            const spec = GENRES[m.genre]!;
            const title = rng.pick(PLAYLIST_TEMPLATES)
                .replace("{w}", rng.pick(spec.words)).replace("{w2}", rng.pick(spec.words)).replace("{g}", spec.name)
                .replace("{t}", ["night", "morning", "afternoon", "evening"][m.hourBin]!);
            const pl = rng.shuffle([...modeTracks[mi]!]).slice(0, 12).map((t) => t.key);
            playlists.push({ owner: id, title, tracks: pl });
            for (const k of pl) events.push({ trackKey: k, kind: "playlist_add", at: now - rng.int(days) * DAY });
        });
        for (let s = 0; s < days * 1.5; s++) {
            const mi = rng.categorical(modes.map((m) => m.weight));
            const m = modes[mi]!;
            const hour = m.hourBin * 6 + rng.int(6);
            const start = now - rng.int(days) * DAY + hour * 3_600_000;
            const pool = modeTracks[mi]!;
            const length = 4 + rng.int(10);
            for (let i = 0; i < length; i++) {
                // favourites are played more: a power law over the pool
                const t = pool[Math.min(pool.length - 1, Math.floor(pool.length * Math.pow(rng.next(), 2)))]!;
                const liked = rng.next() < 0.88;
                const ms = liked ? Math.round(t.durationMs! * (0.6 + 0.4 * rng.next())) : rng.int(25_000);
                events.push({ trackKey: t.key, kind: "stream", at: start + i * 200_000, msPlayed: ms, localHour: hour });
            }
            // noise: a skipped track from outside the user's taste
            if (rng.next() < 0.3) {
                const t = rng.pick(tracks);
                events.push({ trackKey: t.key, kind: "stream", at: start, msPlayed: rng.int(15_000), localHour: hour });
            }
        }
        for (const k of lib) if (rng.next() < 0.2) events.push({ trackKey: k, kind: "save", at: now - rng.int(days) * DAY });
        engagements.set(id, events);
    }
    return { rng, tracks, trackGenre, trackLatent, artistNames, artistGenre, users, owned, engagements, playlists, now };
}

/** does `track` truly belong to one of `user`'s modes (genre, and decade when the mode has one)? */
export function trulyFits(world: SyntheticWorld, user: SyntheticUser, track: TrackInfo): boolean {
    const g = world.trackGenre.get(track.key);
    return user.modes.some((m) => m.genre === g && (m.decade === null || (track.releaseYear! >= m.decade && track.releaseYear! < m.decade + 10)));
}

/** the user's tracks in the pipeline's input shape */
export function userTracks(world: SyntheticWorld, user: SyntheticUser): Map<string, UserTrack> {
    const lib = world.owned.get(user.id)!;
    const titles = new Map<string, string[]>();
    for (const p of world.playlists) if (p.owner === user.id) for (const k of p.tracks) titles.set(k, [...(titles.get(k) ?? []), p.title]);
    const engaged = new Set(world.engagements.get(user.id)!.map((e) => e.trackKey));
    const out = new Map<string, UserTrack>();
    for (const t of world.tracks) {
        if (!lib.has(t.key) && !engaged.has(t.key)) continue;
        out.set(t.key, {
            info: { ...t, owned: lib.has(t.key) },
            cf: world.trackLatent.get(t.key) ?? null,
            embedding: null,
            doc: { genres: t.genres, playlistTitles: titles.get(t.key) ?? [], title: t.title, album: t.album, lyrics: null }
        });
    }
    return out;
}

/** stand-in for ListenBrainz similar recordings / artists: the truth (latent similarity), with noise */
export function syntheticProvider(world: SyntheticWorld, noise = 0.15, missingAudio = 0.1): CandidateProvider {
    const rng = new Rng(4242);
    const byKey = new Map(world.tracks.map((t) => [t.key, t]));
    const graph = new ArtistGraph();
    for (let a = 0; a < world.artistNames.length; a++) {
        for (let b = a + 1; b < world.artistNames.length; b++) {
            if (world.artistGenre[a] === world.artistGenre[b] && rng.next() < 0.3) graph.addEdge(`artist-${a}`, `artist-${b}`, 0.5 + rng.next());
            else if (rng.next() < 0.01) graph.addEdge(`artist-${a}`, `artist-${b}`, 0.3);
        }
    }
    const sim = (a: string, b: string) => {
        const x = world.trackLatent.get(a)!;
        const y = world.trackLatent.get(b)!;
        let d = 0;
        for (let i = 0; i < x.length; i++) d += x[i]! * y[i]!;
        return d;
    };
    return {
        async candidatesFor(mode: ListeningMode, exclude: ReadonlySet<string>): Promise<ProviderCandidate[]> {
            const seeds = mode.members.slice(0, 8).map((m) => m.key).filter((k) => byKey.has(k));
            const collab = new Map<string, { score: number, seed: string }>();
            for (const s of seeds) {
                const scored = world.tracks
                    .filter((t) => !exclude.has(t.key) && t.key !== s)
                    .map((t) => ({ t, score: sim(s, t.key) + noise * rng.normal() }))
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 25);
                for (const { t, score } of scored) {
                    const prev = collab.get(t.key);
                    if (!prev || score > prev.score) collab.set(t.key, { score: (prev?.score ?? 0) + score, seed: s });
                }
            }
            const ppr = graph.personalizedPageRank(new Map(mode.topArtists.map((a) => [a.key, a.weight])));
            return [...collab.entries()].map(([key, c]) => {
                const t = byKey.get(key)!;
                const seedTrack = byKey.get(c.seed)!;
                const doc: TextDoc = { genres: t.genres, playlistTitles: [], title: t.title, album: t.album, lyrics: null };
                return {
                    track: { ...t, audio: null, owned: false },
                    collaborative: c.score,
                    graph: ppr.get(t.artistKey) ?? 0,
                    seedArtist: seedTrack.artistKey !== t.artistKey ? seedTrack.artists[0]! : null,
                    doc
                };
            });
        },
        async enrich(list: readonly TrackInfo[]) {
            const out = new Map<string, TrackInfo | null>();
            for (const t of list) out.set(t.key, { ...t, audio: rng.next() < missingAudio ? null : byKey.get(t.key)?.audio ?? null });
            return out;
        }
    };
}

// ---------------------------------------------------------------- bandit environment

export interface BanditUser {
    embedding: Float64Array,
    likesExplanations: number,
    preferredHour: number,
    device: Device,
    tzOffsetMinutes: number
}

export interface BanditItem {
    key: string,
    input: Omit<ActionInput, "explanation">,
    latent: Float64Array,
    validExplanations: ExplanationKind[]
}

export interface BanditEnv {
    users: BanditUser[],
    items: BanditItem[],
    /** the true probability that card (item, explanation) at `position` is engaged with in this context */
    rewardProbability(user: BanditUser, hour: number, item: BanditItem, explanation: ExplanationKind, position: number): number,
    context(user: BanditUser, hour: number): ContextInput,
    page(user: BanditUser, hour: number, rng: Rng): { shelves: ShelfCandidate[], lookup: Map<string, { item: BanditItem, explanation: ExplanationKind }> }
}

const EXPLANATION_EFFECT: Record<ExplanationKind, number> = {
    none: 0, because_artist: 0.45, from_mix: 0.2, new_release: 0.3, rediscover: 0.25, recently_played: 0.35, similar_to_recent: 0.3
};

const SHELF_OF_KIND: Record<ItemKind, ShelfKind> = {
    mix: "mixes", suggestion: "suggestions", album: "jump_back_in", playlist: "playlists", track: "rediscover"
};

export function generateBanditEnv(seed = 11, nUsers = 50, nItems = 300): BanditEnv {
    const rng = new Rng(seed);
    const users: BanditUser[] = Array.from({ length: nUsers }, () => ({
        embedding: Float64Array.from({ length: USER_EMBEDDING_DIM }, () => rng.normal()),
        likesExplanations: rng.next(),
        preferredHour: rng.int(24),
        device: rng.pick(DEVICES),
        tzOffsetMinutes: rng.pick([-300, 0, 60, 120, 540])
    }));
    const items: BanditItem[] = Array.from({ length: nItems }, (_, i) => {
        const kind = ITEM_KINDS[i % ITEM_KINDS.length]!;
        const audio = Float64Array.from({ length: AUDIO_SUMMARY_DIM }, () => rng.next());
        const owned = kind !== "suggestion";
        const valid: ExplanationKind[] = ["none"];
        if (kind === "suggestion" && rng.next() < 0.6) valid.push("because_artist");
        if (kind === "suggestion" && rng.next() < 0.3) valid.push("new_release");
        if (kind === "track" && rng.next() < 0.7) valid.push("rediscover");
        if ((kind === "album" || kind === "playlist") && rng.next() < 0.5) valid.push("recently_played");
        if (kind !== "mix" && rng.next() < 0.3) valid.push("from_mix");
        return {
            key: `item-${i}`,
            input: {
                kind, audio, affinity: rng.next(), fit: rng.next(), popularity: rng.next(), owned,
                releaseAgeDays: rng.next() < 0.8 ? rng.int(3000) : null, lastPlayedDays: owned ? rng.int(400) : null
            },
            latent: Float64Array.from({ length: USER_EMBEDDING_DIM }, () => rng.normal()),
            validExplanations: valid
        };
    });

    const rewardProbability = (u: BanditUser, hour: number, item: BanditItem, explanation: ExplanationKind, position: number) => {
        let taste = 0;
        for (let i = 0; i < USER_EMBEDDING_DIM; i++) taste += u.embedding[i]! * item.latent[i]!;
        taste /= Math.sqrt(USER_EMBEDDING_DIM);
        const energy = item.input.audio ? item.input.audio[0]! : 0.5;
        // energetic music in the user's preferred hours, calmer outside them (a context x action interaction)
        const hourMatch = Math.cos((2 * Math.PI * (hour - u.preferredHour)) / 24);
        const z = -1.6 + 0.9 * taste + 0.8 * item.input.affinity + 0.6 * hourMatch * (energy - 0.5)
            + EXPLANATION_EFFECT[explanation] * (0.5 + u.likesExplanations)
            + (item.input.kind === "mix" ? 0.3 : 0) - 0.12 * position;
        return sigmoid(z);
    };

    const context = (u: BanditUser, hour: number): ContextInput => ({
        userEmbedding: u.embedding,
        recentAudio: null,
        hour,
        weekday: 3,
        device: u.device,
        tzOffsetMinutes: u.tzOffsetMinutes,
        session: { playsLast30m: 0, skipsLast30m: 0, minutesSinceLastPlay: null },
        librarySize: 500
    });

    const page = (u: BanditUser, hour: number, r: Rng) => {
        const lookup = new Map<string, { item: BanditItem, explanation: ExplanationKind }>();
        const shelves: ShelfCandidate[] = SHELF_KINDS.map((kind) => {
            const pool = r.shuffle(items.filter((it) => SHELF_OF_KIND[it.input.kind] === kind)).slice(0, 15);
            const cards: CardCandidate[] = pool.flatMap((it) => it.validExplanations.map((explanation) => {
                const actionId = `${it.key}#${explanation}`;
                lookup.set(actionId, { item: it, explanation });
                return { actionId, itemKey: it.key, action: encodeAction({ ...it.input, explanation }), explanation: { kind: explanation } };
            }));
            return { id: kind, kind, cards, maxCards: 6 };
        });
        return { shelves, lookup };
    };
    return { users, items, rewardProbability, context, page };
}
