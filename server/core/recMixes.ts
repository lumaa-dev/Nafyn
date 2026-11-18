// personalized mixes ("Made For You"): generation for one user, persistence, and the reads behind the API.
//
// A refresh is claimed through rec_user_state (status + heartbeat), so two schedulers - or the scheduler and
// a manual "Refresh" - never build the same user's mixes at once. Mix ids survive a refresh when the new
// mode is the same listening mode as an old one (centroid matching, see assemble.ts).
import { randomUUID } from "node:crypto";
import { getLibrariesDb, sqlInt, withTransaction } from "./db";
import { CatalogProvider } from "./recCatalog";
import { countSignals, getGlobalModels, loadUserData, neighbourArtists, userEmbedding } from "./recData";
import { isPersonalizationEnabled } from "./recSettings";
import { getRecConfig } from "../utils/recConfig";
import { withMusicBrainzContext } from "../utils/musicbrainzRepository";
import { base64ToF64, f64ToBase64 } from "../utils/recommender/math";
import { type MixEngineConfig, generateMixes } from "../utils/recommender/mixes/pipeline";
import { type MixLabel, fallbackTitle } from "../utils/recommender/mixes/types";
import type { TrackReason } from "../utils/recommender/mixes/assemble";

const STALE_RUN_MS = 15 * 60_000;
export const MANUAL_REFRESH_COOLDOWN_MS = 10 * 60_000;

function engineConfig(): MixEngineConfig {
    const c = getRecConfig();
    return {
        modes: {
            minMixes: 1, maxMixes: c.maxMixes, minTracksPerMode: c.minTracksPerMode, minModeShare: c.minModeShare,
            restarts: 4, recencyHalfLifeDays: c.recencyHalfLifeDays, seed: c.seed
        },
        assemble: {
            mixLength: c.mixLength, familiarRatio: c.familiarRatio, maxTracksPerArtist: c.maxTracksPerArtist,
            sequence: { arc: c.energyArc, artistSeparation: c.artistSeparation, maxNovelRun: c.maxNovelRun, twoOptPasses: 3 }
        },
        sourceWeights: c.sourceWeights,
        audioShortlist: c.audioShortlist,
        minSimilarityToKeepId: 0.5
    };
}

/** claims the user's refresh; false when another one is running (and alive) */
async function claim(userId: string): Promise<boolean> {
    const now = Date.now();
    await getLibrariesDb().prepare(`INSERT IGNORE INTO rec_user_state (user_id, status) VALUES (?, 'idle')`).run(userId);
    const result = await getLibrariesDb().prepare(`
        UPDATE rec_user_state SET status = 'running', heartbeat_at = :now, error = NULL
        WHERE user_id = :userId AND (status <> 'running' OR heartbeat_at IS NULL OR heartbeat_at < :stale)
    `).run({ userId, now, stale: now - STALE_RUN_MS });
    return result.changes === 1;
}

export interface RefreshOutcome {
    mixes: number,
    suggestions: number,
    elapsedMs: number
}

export async function refreshUserMixes(userId: string): Promise<RefreshOutcome | null> {
    if (!getRecConfig().enabled || !await isPersonalizationEnabled(userId)) return null;
    if (!await claim(userId)) return null;
    const started = Date.now();
    const db = getLibrariesDb();
    try {
        const models = await getGlobalModels();
        const data = await loadUserData(userId, models);
        const previousRows = await db.prepare(`SELECT id, centroid, created_at FROM rec_mixes WHERE user_id = ?`)
            .all<{ id: string, centroid: string, created_at: number | string }>(userId);
        const createdAt = new Map(previousRows.map((r) => [r.id, Number(r.created_at)]));
        const provider = new CatalogProvider(userId, data.tracks, data.ownedRecordings, neighbourArtists(models, userId), getRecConfig().candidatesPerMode);

        const result = await withMusicBrainzContext({ lane: "bulk", key: `rec:${userId}` }, () => generateMixes({
            now: started,
            tracks: data.tracks,
            engagements: data.engagements,
            previous: previousRows.map((r) => ({ id: r.id, centroid: base64ToF64(r.centroid) }))
        }, provider, engineConfig()));

        // the user's most engaged artists: what "Because you listened to X" may name (explanations.ts)
        const artistWeight = new Map<string, number>();
        for (const [key, a] of result.affinities) {
            const t = data.tracks.get(key);
            if (!t) continue;
            const name = t.info.artists[0]?.toLowerCase();
            if (name) artistWeight.set(name, (artistWeight.get(name) ?? 0) + Math.max(0, a.positive - a.negative));
        }
        const topArtists = [...artistWeight].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([n]) => n);
        const embedding = userEmbedding(models, userId);
        let suggestions = 0;

        await withTransaction(async (conn) => {
            await conn.execute(`DELETE t FROM rec_mix_tracks t JOIN rec_mixes m ON m.id = t.mix_id WHERE m.user_id = ?`, [userId]);
            await conn.execute(`DELETE FROM rec_mixes WHERE user_id = ?`, [userId]);
            for (const [position, mix] of result.mixes.entries()) {
                const id = mix.previousId ?? randomUUID();
                await conn.execute(`
                    INSERT INTO rec_mixes (id, user_id, position, label, title, share, centroid, top_artists, created_at, refreshed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [id, userId, position, JSON.stringify(mix.label), mix.title.slice(0, 255), mix.share, f64ToBase64(mix.centroid),
                    JSON.stringify(mix.topArtists.map((a) => a.name)), createdAt.get(id) ?? started, started]);
                for (const t of mix.tracks) {
                    const info = mix.info.get(t.key)!;
                    const display = provider.display.get(t.key);
                    if (!t.familiar) suggestions++;
                    await conn.execute(`
                        INSERT INTO rec_mix_tracks (mix_id, position, track_key, media_id, recording_id, familiar, confidence, reason,
                                                    title, artist, album, album_id, cover_art, duration_ms, released_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [id, t.position, t.key.slice(0, 64), t.familiar ? t.key : null, info.recordingId, t.familiar ? 1 : 0, t.confidence,
                        JSON.stringify(t.reason), info.title.slice(0, 512), (display?.artistCredit ?? info.artists.join(", ")).slice(0, 512),
                        info.album?.slice(0, 512) ?? null, info.albumId, display?.coverArt ?? null,
                        info.durationMs !== null ? Math.round(info.durationMs) : null, info.releasedAt]);
                }
            }
            await conn.execute(`
                UPDATE rec_user_state SET status = 'idle', last_refresh_at = ?, signals_at_refresh = ?, heartbeat_at = ?,
                    embedding = ?, top_artists = ?, error = NULL
                WHERE user_id = ?
            `, [started, data.signals, Date.now(), embedding ? f64ToBase64(embedding) : null, JSON.stringify(topArtists), userId]);
        });
        return { mixes: result.mixes.length, suggestions, elapsedMs: Date.now() - started };
    } catch (error) {
        await db.prepare(`UPDATE rec_user_state SET status = 'failed', error = ?, heartbeat_at = ? WHERE user_id = ?`)
            .run(String((error as Error)?.message ?? error).slice(0, 2000), Date.now(), userId);
        throw error;
    }
}

/** the next user whose mixes are due (stale, or enough new listening since the last refresh), if any */
export async function nextDueUser(): Promise<string | null> {
    const c = getRecConfig();
    const now = Date.now();
    const rows = await getLibrariesDb().prepare(`
        SELECT u.id, s.last_refresh_at, s.signals_at_refresh, s.status, s.heartbeat_at
        FROM users u
        LEFT JOIN rec_user_settings rs ON rs.user_id = u.id
        LEFT JOIN rec_user_state s ON s.user_id = u.id
        WHERE (rs.user_id IS NULL OR rs.enabled = 1)
        ORDER BY s.last_refresh_at IS NOT NULL, s.last_refresh_at ASC
        LIMIT ${sqlInt(25)}
    `).all<{ id: string, last_refresh_at: number | string | null, signals_at_refresh: number | null, status: string | null, heartbeat_at: number | string | null }>();
    for (const r of rows) {
        if (r.status === "running" && r.heartbeat_at && now - Number(r.heartbeat_at) < STALE_RUN_MS) continue;
        // a failed refresh waits a full period before trying again
        if (r.status === "failed" && r.heartbeat_at && now - Number(r.heartbeat_at) < c.refreshHours * 3_600_000) continue;
        if (r.last_refresh_at === null) return r.id;
        if (now - Number(r.last_refresh_at) >= c.refreshHours * 3_600_000) return r.id;
        const signals = await countSignals(r.id);
        if (signals - Number(r.signals_at_refresh ?? 0) >= c.refreshMinNewEvents) return r.id;
    }
    return null;
}

// ---------------------------------------------------------------- reads

export interface MixSummary {
    id: string,
    position: number,
    label: MixLabel,
    title: string,
    topArtists: string[],
    trackCount: number,
    familiarCount: number,
    /** up to four covers for a mosaic (stored Cover Art Archive URLs, rewritten on the way out) */
    covers: string[],
    refreshedAt: number
}

export interface RefreshState {
    refreshing: boolean,
    refreshedAt: number | null,
    failed: boolean
}

export async function getRefreshState(userId: string): Promise<RefreshState> {
    const row = await getLibrariesDb().prepare(`SELECT status, last_refresh_at, heartbeat_at FROM rec_user_state WHERE user_id = ?`)
        .get<{ status: string, last_refresh_at: number | string | null, heartbeat_at: number | string | null }>(userId);
    if (!row) return { refreshing: false, refreshedAt: null, failed: false };
    return {
        refreshing: row.status === "running" && !!row.heartbeat_at && Date.now() - Number(row.heartbeat_at) < STALE_RUN_MS,
        refreshedAt: row.last_refresh_at === null ? null : Number(row.last_refresh_at),
        failed: row.status === "failed"
    };
}

export async function listMixes(userId: string): Promise<MixSummary[]> {
    const db = getLibrariesDb();
    const mixes = await db.prepare(`SELECT id, position, label, title, top_artists, refreshed_at FROM rec_mixes WHERE user_id = ? ORDER BY position`)
        .all<{ id: string, position: number, label: unknown, title: string, top_artists: unknown, refreshed_at: number | string }>(userId);
    if (mixes.length === 0) return [];
    const stats = await db.prepare(`
        SELECT t.mix_id, COUNT(*) AS n, SUM(t.familiar) AS f FROM rec_mix_tracks t
        JOIN rec_mixes m ON m.id = t.mix_id WHERE m.user_id = ? GROUP BY t.mix_id
    `).all<{ mix_id: string, n: number | string, f: number | string }>(userId);
    const covers = await db.prepare(`
        SELECT t.mix_id, t.position, COALESCE(media.coverArt, t.cover_art) AS cover FROM rec_mix_tracks t
        JOIN rec_mixes m ON m.id = t.mix_id
        LEFT JOIN media ON media.id = t.media_id
        WHERE m.user_id = ? ORDER BY t.mix_id, t.position
    `).all<{ mix_id: string, position: number, cover: string | null }>(userId);
    const byMix = new Map<string, string[]>();
    for (const c of covers) {
        if (!c.cover) continue;
        const list = byMix.get(c.mix_id) ?? [];
        if (list.length < 4 && !list.includes(c.cover)) list.push(c.cover);
        byMix.set(c.mix_id, list);
    }
    const statOf = new Map(stats.map((s) => [s.mix_id, s]));
    return mixes.map((m) => {
        const label = (typeof m.label === "string" ? JSON.parse(m.label) : m.label) as MixLabel;
        return {
            id: m.id,
            position: m.position,
            label,
            title: m.title || fallbackTitle(label),
            topArtists: (typeof m.top_artists === "string" ? JSON.parse(m.top_artists) : m.top_artists) as string[],
            trackCount: Number(statOf.get(m.id)?.n ?? 0),
            familiarCount: Number(statOf.get(m.id)?.f ?? 0),
            covers: byMix.get(m.id) ?? [],
            refreshedAt: Number(m.refreshed_at)
        };
    });
}

export interface MixTrackSuggestion {
    recordingId: string,
    title: string,
    artist: string,
    album: string | null,
    albumId: string | null,
    coverArt: string | null,
    durationMs: number | null,
    releasedAt: number | null
}

export interface MixTrackEntry {
    position: number,
    familiar: boolean,
    confidence: number,
    reason: TrackReason,
    /** familiar: the full media row the player plays */
    media: Record<string, unknown> | null,
    /** novel: the catalogue recording, requestable */
    suggestion: MixTrackSuggestion | null
}

export async function getMix(userId: string, mixId: string): Promise<(MixSummary & { tracks: MixTrackEntry[] }) | null> {
    const summary = (await listMixes(userId)).find((m) => m.id === mixId);
    if (!summary) return null;
    const rows = await getLibrariesDb().prepare(`
        SELECT t.*, media.id AS m_id FROM rec_mix_tracks t LEFT JOIN media ON media.id = t.media_id
        WHERE t.mix_id = ? ORDER BY t.position
    `).all<Record<string, unknown>>(mixId);
    const mediaIds = rows.map((r) => r.media_id).filter((x): x is string => typeof x === "string");
    const mediaRows = mediaIds.length
        ? await getLibrariesDb().prepare(`
            SELECT media.*, EXISTS (SELECT 1 FROM library_entries le WHERE le.mediaId = media.id AND le.userId = ?) AS inLibrary
            FROM media WHERE id IN (${mediaIds.map(() => "?").join(", ")})
        `).all<Record<string, unknown>>(userId, ...mediaIds)
        : [];
    const mediaById = new Map(mediaRows.map((m) => [m.id as string, { ...m, inLibrary: Number(m.inLibrary) === 1 }]));
    const tracks: MixTrackEntry[] = [];
    for (const r of rows) {
        const familiar = Number(r.familiar) === 1;
        const reason = (typeof r.reason === "string" ? JSON.parse(r.reason) : r.reason) as TrackReason;
        if (familiar) {
            const media = mediaById.get(r.media_id as string);
            // a familiar track deleted from the server since the refresh is simply left out
            if (!media) continue;
            tracks.push({ position: Number(r.position), familiar, confidence: Number(r.confidence), reason, media, suggestion: null });
        } else {
            tracks.push({
                position: Number(r.position), familiar, confidence: Number(r.confidence), reason, media: null,
                suggestion: {
                    recordingId: r.recording_id as string,
                    title: r.title as string,
                    artist: r.artist as string,
                    album: (r.album as string | null) ?? null,
                    albumId: (r.album_id as string | null) ?? null,
                    coverArt: (r.cover_art as string | null) ?? null,
                    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
                    releasedAt: r.released_at === null ? null : Number(r.released_at)
                }
            });
        }
    }
    return { ...summary, tracks };
}

/** for the export: every mix and its tracks, as stored */
export async function listMixExportForUser(userId: string): Promise<unknown[]> {
    const mixes = await listMixes(userId);
    const out: unknown[] = [];
    for (const m of mixes) {
        const tracks = await getLibrariesDb().prepare(`
            SELECT position, track_key, media_id, recording_id, familiar, confidence, reason, title, artist, album FROM rec_mix_tracks
            WHERE mix_id = ? ORDER BY position
        `).all(m.id);
        out.push({ ...m, tracks });
    }
    return out;
}
