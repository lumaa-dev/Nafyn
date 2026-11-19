// what the recommender reads from Nafyn's own tables, and the instance-wide models built from it.
//
// Per user (only while their personalization is on):
//   saves         - library entries (requesting a song and keeping it is the strongest signal there is)
//   playlist adds - entries the user added to playlists, and the titles of the playlists a track sits in
//   streams       - play_events, but only while the user's listening history (its own opt-in) is on; with it
//                   off, the recently-played shelf counts as plays of unknown length
// Instance-wide, rebuilt hourly, from users who have personalization on:
//   collaborative filtering (implicit ALS) over library / playlist / play signals
//   co-occurrence embeddings of tracks (playlists and listening sessions, PPMI + randomized SVD)
// Neither is ever used to show one user another user's tracks: suggestions come from the public catalogue.
import { getLibrariesDb } from "./db";
import { getInsightSettings } from "./insightsSettings";
import { getMusicBrainzRepository } from "../utils/musicbrainz";
import { withMusicBrainzContext } from "../utils/musicbrainzRepository";
import { getAudioFeatures } from "./recAudio";
import { type AlsModel, similarUsers, trainAls } from "../utils/recommender/mixes/als";
import { countCooccurrences, ppmi, randomizedEmbedding } from "../utils/recommender/mixes/graph";
import { audioDbTags, trackTags } from "./recAudioDb";
import { moodFromTag, tagGenres, tagWords } from "../utils/audioDbTags";
import type { Engagement, TrackInfo } from "../utils/recommender/mixes/types";
import type { UserTrack } from "../utils/recommender/mixes/pipeline";
import { USER_EMBEDDING_DIM } from "../utils/recommender/bandit/features";

const DAY = 86_400_000;
const HISTORY_DAYS = 365;
const SESSION_GAP_MS = 30 * 60_000;
const EMBEDDING_DIM = 16;
const GLOBAL_TTL_MS = 60 * 60_000;
const GENRE_TTL_MS = 30 * DAY;
// TheAudioDB lookups one refresh of a user's mixes may spend (2.1 s apart, see recAudioDb.ts); the rest of a large
// library is asked about on the next refreshes, the answers being kept 30 days
const AUDIODB_LOOKUPS_PER_REFRESH = 24;

export function artistKeyOf(name: string | null | undefined): string {
    return (name ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------- instance-wide models

export interface GlobalModels {
    builtAt: number,
    userIndex: Map<string, number>,
    mediaIndex: Map<string, number>,
    als: AlsModel | null,
    embeddings: Float64Array[],
    /** per user index: the artists (lowercased names) they hold, with weight */
    userArtists: Map<string, number>[]
}

let globalModels: GlobalModels | null = null;
let building: Promise<GlobalModels> | null = null;

async function enabledUserIds(): Promise<string[]> {
    const rows = await getLibrariesDb().prepare(`
        SELECT u.id FROM users u
        LEFT JOIN rec_user_settings s ON s.user_id = u.id
        WHERE s.user_id IS NULL OR s.enabled = 1
    `).all<{ id: string }>();
    return rows.map((r) => r.id);
}

async function buildGlobalModels(): Promise<GlobalModels> {
    const db = getLibrariesDb();
    const users = await enabledUserIds();
    const userIndex = new Map(users.map((u, i) => [u, i]));
    const mediaIndex = new Map<string, number>();
    const idx = (m: string) => {
        let i = mediaIndex.get(m);
        if (i === undefined) mediaIndex.set(m, (i = mediaIndex.size));
        return i;
    };
    const weights = new Map<string, number>();
    const add = (u: number, m: number, w: number) => weights.set(`${u}:${m}`, (weights.get(`${u}:${m}`) ?? 0) + w);
    const userArtists: Map<string, number>[] = users.map(() => new Map());

    const library = await db.prepare(`SELECT le.userId, le.mediaId, m.artistName FROM library_entries le JOIN media m ON m.id = le.mediaId`)
        .all<{ userId: string, mediaId: string, artistName: string }>();
    for (const r of library) {
        const u = userIndex.get(r.userId);
        if (u === undefined) continue;
        add(u, idx(r.mediaId), 3);
        const a = artistKeyOf(r.artistName);
        userArtists[u]!.set(a, (userArtists[u]!.get(a) ?? 0) + 1);
    }
    const added = await db.prepare(`SELECT addedBy, mediaId FROM playlist_entries`).all<{ addedBy: string, mediaId: string }>();
    for (const r of added) {
        const u = userIndex.get(r.addedBy);
        if (u !== undefined) add(u, idx(r.mediaId), 2.5);
    }
    // play counts only for users whose listening history is on (no play_events exist otherwise)
    const plays = await db.prepare(`
        SELECT user_id, track_id, COUNT(*) AS n FROM play_events
        WHERE duration_ms >= 30000 AND started_at >= FROM_UNIXTIME(:from / 1000)
        GROUP BY user_id, track_id
    `).all<{ user_id: string, track_id: string, n: number | string }>({ from: Date.now() - HISTORY_DAYS * DAY });
    for (const r of plays) {
        const u = userIndex.get(r.user_id);
        if (u !== undefined) add(u, idx(r.track_id), Math.log1p(Number(r.n)));
    }

    const data = [...weights].map(([k, w]) => {
        const [u, m] = k.split(":").map(Number);
        return { user: u!, item: m!, weight: w };
    });
    const als = users.length && mediaIndex.size
        ? trainAls(users.length, mediaIndex.size, data, { factors: USER_EMBEDDING_DIM, reg: 0.1, alpha: 5, iterations: 8, seed: 17 })
        : null;

    // co-occurrence groups: playlists in their order, and listening sessions
    const groups: number[][] = [];
    const entries = await db.prepare(`SELECT playlistId, mediaId FROM playlist_entries ORDER BY playlistId, position`).all<{ playlistId: string, mediaId: string }>();
    let current: string | null = null;
    for (const e of entries) {
        if (e.playlistId !== current) {
            groups.push([]);
            current = e.playlistId;
        }
        groups[groups.length - 1]!.push(idx(e.mediaId));
    }
    const events = await db.prepare(`
        SELECT user_id, track_id, started_at FROM play_events
        WHERE started_at >= FROM_UNIXTIME(:from / 1000) ORDER BY user_id, started_at
    `).all<{ user_id: string, track_id: string, started_at: Date }>({ from: Date.now() - 180 * DAY });
    let lastUser = "";
    let lastAt = 0;
    for (const e of events) {
        if (!userIndex.has(e.user_id)) continue;
        const at = new Date(e.started_at).getTime();
        if (e.user_id !== lastUser || at - lastAt > SESSION_GAP_MS) groups.push([]);
        groups[groups.length - 1]!.push(idx(e.track_id));
        lastUser = e.user_id;
        lastAt = at;
    }
    const embeddings = randomizedEmbedding(ppmi(countCooccurrences(mediaIndex.size, groups.filter((g) => g.length > 1))), mediaIndex.size, EMBEDDING_DIM, 23);

    return { builtAt: Date.now(), userIndex, mediaIndex, als, embeddings, userArtists };
}

export async function getGlobalModels(force = false): Promise<GlobalModels> {
    if (!force && globalModels && Date.now() - globalModels.builtAt < GLOBAL_TTL_MS) return globalModels;
    building ??= buildGlobalModels().then((m) => {
        globalModels = m;
        return m;
    }).finally(() => {
        building = null;
    });
    return await building;
}

/** the user's collaborative-filtering factors, null for a user the model does not know (cold start) */
export function userEmbedding(models: GlobalModels, userId: string): Float64Array | null {
    const u = models.userIndex.get(userId);
    if (u === undefined || !models.als) return null;
    const v = models.als.users[u]!;
    return v.some((x) => x !== 0) ? v : null;
}

/**
 * Artists the user's nearest neighbours (ALS) hold, kept only when at least two different neighbours hold
 * them - a weak k-anonymity: no suggestion ever traces back to one other person's library.
 */
export function neighbourArtists(models: GlobalModels, userId: string): Map<string, number> {
    const u = models.userIndex.get(userId);
    const out = new Map<string, number>();
    if (u === undefined || !models.als) return out;
    const holders = new Map<string, { users: number, weight: number }>();
    for (const n of similarUsers(models.als, u, 10)) {
        if (n.similarity <= 0) continue;
        for (const [artist, count] of models.userArtists[n.user]!) {
            const h = holders.get(artist) ?? { users: 0, weight: 0 };
            h.users++;
            h.weight += n.similarity * Math.log1p(count);
            holders.set(artist, h);
        }
    }
    for (const [artist, h] of holders) if (h.users >= 2) out.set(artist, h.weight);
    return out;
}

// ---------------------------------------------------------------- genres (MusicBrainz, cached)

export async function artistGenres(artistMbids: readonly string[], maxLookups: number): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const ids = [...new Set(artistMbids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).map((id) => id.toLowerCase()))];
    if (ids.length === 0) return out;
    const db = getLibrariesDb();
    const rows = await db.prepare(`
        SELECT cache_key, payload, fetched_at FROM rec_external_cache WHERE cache_key IN (${ids.map(() => "?").join(", ")})
    `).all<{ cache_key: string, payload: string, fetched_at: number | string }>(...ids.map((id) => `mb:genres:${id}`));
    const fresh = new Set<string>();
    for (const r of rows) {
        const id = r.cache_key.slice("mb:genres:".length);
        out.set(id, JSON.parse(r.payload) as string[]);
        if (Date.now() - Number(r.fetched_at) < GENRE_TTL_MS) fresh.add(id);
    }
    let lookups = 0;
    for (const id of ids) {
        if (fresh.has(id) || lookups >= maxLookups) continue;
        lookups++;
        try {
            const artist = await withMusicBrainzContext({ lane: "bulk", key: "recommendations" }, () =>
                getMusicBrainzRepository().lookup("artist", id, ["genres"] as never)) as unknown as { genres?: { name: string, count: number }[] };
            const genres = (artist.genres ?? []).sort((a, b) => b.count - a.count).slice(0, 6).map((g) => g.name.toLowerCase());
            out.set(id, genres);
            await db.prepare(`
                INSERT INTO rec_external_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = VALUES(fetched_at)
            `).run(`mb:genres:${id}`, JSON.stringify(genres), Date.now());
        } catch {
            // MusicBrainz busy: keep the stale answer if there is one, the next refresh tries again
        }
    }
    return out;
}

// ---------------------------------------------------------------- one user's data

interface MediaRow {
    id: string,
    musicbrainzId: string,
    title: string,
    artistName: string,
    artistMbid: string | null,
    album: string | null,
    albumId: string | null,
    releaseDate: number | string | null,
    duration: number,
    owned: number,
    addedAt: number | string | null
}

export interface UserData {
    tracks: Map<string, UserTrack>,
    engagements: Engagement[],
    /** count of engagement signals - a refresh is due when it grew by refreshMinNewEvents */
    signals: number,
    /** recording MBIDs the user already holds (media.musicbrainzId + merged aliases) */
    ownedRecordings: Set<string>,
    tzOffsetMinutes: number,
    historyEnabled: boolean
}

export async function countSignals(userId: string): Promise<number> {
    const row = await getLibrariesDb().prepare(`
        SELECT
            (SELECT COUNT(*) FROM library_entries WHERE userId = :u) +
            (SELECT COUNT(*) FROM playlist_entries WHERE addedBy = :u) +
            (SELECT COUNT(*) FROM play_events WHERE user_id = :u) +
            (SELECT COUNT(*) FROM recently_played WHERE userId = :u) AS n
    `).get<{ n: number | string }>({ u: userId });
    return Number(row?.n ?? 0);
}

export async function loadUserData(userId: string, models: GlobalModels): Promise<UserData> {
    const db = getLibrariesDb();
    const settings = await getInsightSettings(userId);
    const tz = settings.tzOffsetMinutes;
    const localHour = (ms: number) => new Date(ms + tz * 60_000).getUTCHours();

    // the library, and tracks of visible playlists the user engaged with (both playable for them)
    const rows = await db.prepare(`
        SELECT m.id, m.musicbrainzId, m.title, m.artistName, m.artistMbid, m.album, m.albumId, m.releaseDate, m.duration,
               1 AS owned, le.addedAt
        FROM library_entries le JOIN media m ON m.id = le.mediaId
        WHERE le.userId = :u
        UNION
        SELECT m.id, m.musicbrainzId, m.title, m.artistName, m.artistMbid, m.album, m.albumId, m.releaseDate, m.duration,
               0 AS owned, NULL AS addedAt
        FROM playlist_entries pe
        JOIN playlists p ON p.id = pe.playlistId
        LEFT JOIN playlist_members pm ON pm.playlistId = p.id AND pm.userId = :u
        JOIN media m ON m.id = pe.mediaId
        WHERE (p.ownerId = :u OR pm.id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM library_entries le2 WHERE le2.userId = :u AND le2.mediaId = m.id)
    `).all<MediaRow>({ u: userId });
    const media = new Map<string, MediaRow>();
    for (const r of rows) if (!media.has(r.id) || r.owned) media.set(r.id, r);

    const playlistTitles = new Map<string, string[]>();
    const titleRows = await db.prepare(`
        SELECT pe.mediaId, p.title FROM playlist_entries pe
        JOIN playlists p ON p.id = pe.playlistId
        LEFT JOIN playlist_members pm ON pm.playlistId = p.id AND pm.userId = :u
        WHERE p.ownerId = :u OR pm.id IS NOT NULL
    `).all<{ mediaId: string, title: string }>({ u: userId });
    for (const r of titleRows) playlistTitles.set(r.mediaId, [...(playlistTitles.get(r.mediaId) ?? []), r.title]);

    const lyrics = new Map<string, string>();
    const ids = [...media.keys()];
    for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const lrows = await db.prepare(`SELECT mediaId, content FROM media_lyrics WHERE mediaId IN (${chunk.map(() => "?").join(", ")})`).all<{ mediaId: string, content: string }>(...chunk);
        for (const l of lrows) lyrics.set(l.mediaId, l.content.slice(0, 4000));
    }
    const audio = await getAudioFeatures(ids.map((id) => `media:${id}`));
    const genres = await artistGenres([...media.values()].map((m) => m.artistMbid ?? "").filter(Boolean), 40);
    // what TheAudioDB's editors say the albums and artists sound like: a genre where MusicBrainz has none, a mood
    // where no preview was measured, and their words in the text profile
    const editorTags = await audioDbTags([...media.values()], AUDIODB_LOOKUPS_PER_REFRESH);

    const ownedRecordings = new Set<string>();
    for (const m of media.values()) if (m.owned) ownedRecordings.add(m.musicbrainzId.toLowerCase());
    const aliases = await db.prepare(`
        SELECT mi.value FROM media_identifiers mi JOIN library_entries le ON le.mediaId = mi.mediaId
        WHERE le.userId = ? AND mi.kind = 'mbid'
    `).all<{ value: string }>(userId);
    for (const a of aliases) ownedRecordings.add(a.value.toLowerCase());

    const tracks = new Map<string, UserTrack>();
    for (const m of media.values()) {
        const releasedAt = m.releaseDate ? Number(m.releaseDate) : null;
        const tags = trackTags(editorTags, m.artistMbid, m.albumId);
        const mbGenres = m.artistMbid ? genres.get(m.artistMbid.toLowerCase()) ?? [] : [];
        const info: TrackInfo = {
            key: m.id,
            recordingId: m.musicbrainzId || null,
            title: m.title,
            artists: [m.artistName],
            artistKey: artistKeyOf(m.artistName),
            album: m.album,
            albumId: m.albumId,
            releaseYear: releasedAt ? new Date(releasedAt).getUTCFullYear() : null,
            releasedAt,
            durationMs: m.duration ? m.duration * 1000 : null,
            genres: mbGenres.length ? mbGenres : tagGenres(tags),
            audio: audio.get(`media:${m.id}`) ?? null,
            tagMood: moodFromTag(tags.mood),
            tags: tagWords(tags),
            owned: m.owned === 1
        };
        const gi = models.mediaIndex.get(m.id);
        tracks.set(m.id, {
            info,
            cf: gi !== undefined && models.als ? models.als.items[gi]! : null,
            embedding: gi !== undefined ? models.embeddings[gi] ?? null : null,
            doc: { genres: [...new Set([...info.genres, ...(info.tags ?? [])])], playlistTitles: playlistTitles.get(m.id) ?? [], title: m.title, album: m.album, lyrics: lyrics.get(m.id) ?? null }
        });
    }

    const engagements: Engagement[] = [];
    for (const m of media.values()) {
        if (m.owned && m.addedAt) engagements.push({ trackKey: m.id, kind: "save", at: Number(m.addedAt) });
    }
    const adds = await db.prepare(`SELECT mediaId, addedAt FROM playlist_entries WHERE addedBy = ?`).all<{ mediaId: string, addedAt: number | string }>(userId);
    for (const a of adds) if (tracks.has(a.mediaId)) engagements.push({ trackKey: a.mediaId, kind: "playlist_add", at: Number(a.addedAt) });

    if (settings.historyEnabled) {
        const plays = await db.prepare(`
            SELECT track_id, started_at, duration_ms FROM play_events
            WHERE user_id = :u AND started_at >= FROM_UNIXTIME(:from / 1000)
        `).all<{ track_id: string, started_at: Date, duration_ms: number }>({ u: userId, from: Date.now() - HISTORY_DAYS * DAY });
        for (const p of plays) {
            if (!tracks.has(p.track_id)) continue;
            const at = new Date(p.started_at).getTime();
            engagements.push({ trackKey: p.track_id, kind: "stream", at, msPlayed: p.duration_ms, localHour: localHour(at) });
        }
    } else {
        // without listening history, the recently-played shelf (always kept, 180 days) says that something was
        // played and when - not for how long: counted as one modest listen
        const recent = await db.prepare(`SELECT refId, playedAt FROM recently_played WHERE userId = ? AND type = 'track'`).all<{ refId: string, playedAt: number | string }>(userId);
        for (const r of recent) {
            if (!tracks.has(r.refId)) continue;
            const at = Number(r.playedAt);
            engagements.push({ trackKey: r.refId, kind: "stream", at, msPlayed: 60_000, localHour: localHour(at) });
        }
    }

    return { tracks, engagements, signals: await countSignals(userId), ownedRecordings, tzOffsetMinutes: tz, historyEnabled: settings.historyEnabled };
}
