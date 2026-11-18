// ListenBrainz Labs similarity (https://labs.api.listenbrainz.org), the collaborative-filtering and artist-graph
// evidence behind mix suggestions: recordings and artists that ListenBrainz' listeners play in the same
// sessions. Public, no key, MBID-native.
//
// What is sent: one recording or artist MBID per request - never a user, account or listening history.
// Answers are cached a week in rec_external_cache (they are aggregates over millions of listens and barely
// move), and requests are spaced process-wide so a refresh of many mixes cannot hammer a free service.
import { APP_GITHUB, APP_NAME, APP_VERSION } from "./app";
import { getLibrariesDb } from "../core/db";

const BASE = "https://labs.api.listenbrainz.org";
const SIMILAR_RECORDINGS_ALGORITHM = "session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30";
const SIMILAR_ARTISTS_ALGORITHM = "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";
const TTL_MS = 7 * 86_400_000;
const MIN_INTERVAL_MS = 1100;
const TIMEOUT_MS = 10_000;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SimilarRecording {
    recordingId: string,
    title: string,
    artist: string,
    release: string | null,
    /** release MBID whose front cover the Cover Art Archive has */
    coverReleaseId: string | null,
    score: number
}

export interface SimilarArtist {
    artistId: string,
    name: string,
    score: number
}

let nextSlot = 0;

async function paced<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + MIN_INTERVAL_MS;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    return await fn();
}

async function cached<T>(key: string, fetcher: () => Promise<T | null>): Promise<T | null> {
    const db = getLibrariesDb();
    const row = await db.prepare(`SELECT payload, fetched_at FROM rec_external_cache WHERE cache_key = ?`).get<{ payload: string, fetched_at: number | string }>(key);
    if (row && Date.now() - Number(row.fetched_at) < TTL_MS) return JSON.parse(row.payload) as T;
    const fresh = await fetcher();
    // a failed fetch keeps serving the stale answer rather than nothing
    if (fresh === null) return row ? (JSON.parse(row.payload) as T) : null;
    await db.prepare(`
        INSERT INTO rec_external_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = VALUES(fetched_at)
    `).run(key, JSON.stringify(fresh), Date.now());
    return fresh;
}

async function getJson(url: string): Promise<unknown | null> {
    return await paced(async () => {
        const response = await fetch(url, {
            headers: { Accept: "application/json", "User-Agent": `${APP_NAME}/${APP_VERSION} ( ${APP_GITHUB} )` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: "error"
        }).catch(() => null);
        if (!response?.ok) return null;
        return await response.json().catch(() => null);
    });
}

export async function similarRecordings(recordingId: string): Promise<SimilarRecording[]> {
    if (!MBID_RE.test(recordingId)) return [];
    const id = recordingId.toLowerCase();
    const result = await cached<SimilarRecording[]>(`lb:simrec:${id}`, async () => {
        const body = await getJson(`${BASE}/similar-recordings/json?recording_mbids=${id}&algorithm=${SIMILAR_RECORDINGS_ALGORITHM}`);
        if (!Array.isArray(body)) return null;
        return body
            .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof r.recording_mbid === "string" && MBID_RE.test(r.recording_mbid as string))
            .map((r) => ({
                recordingId: (r.recording_mbid as string).toLowerCase(),
                title: String(r.recording_name ?? ""),
                artist: String(r.artist_credit_name ?? ""),
                release: typeof r.release_name === "string" ? r.release_name : null,
                coverReleaseId: typeof r.caa_release_mbid === "string" && MBID_RE.test(r.caa_release_mbid) ? r.caa_release_mbid.toLowerCase() : null,
                score: Number(r.score) || 0
            }));
    });
    return result ?? [];
}

export async function similarArtists(artistId: string): Promise<SimilarArtist[]> {
    if (!MBID_RE.test(artistId)) return [];
    const id = artistId.toLowerCase();
    const result = await cached<SimilarArtist[]>(`lb:simart:${id}`, async () => {
        const body = await getJson(`${BASE}/similar-artists/json?artist_mbids=${id}&algorithm=${SIMILAR_ARTISTS_ALGORITHM}`);
        if (!Array.isArray(body)) return null;
        return body
            .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof r.artist_mbid === "string" && MBID_RE.test(r.artist_mbid as string))
            .map((r) => ({ artistId: (r.artist_mbid as string).toLowerCase(), name: String(r.name ?? ""), score: Number(r.score) || 0 }));
    });
    return result ?? [];
}

/** drops cached answers older than their TTL (retention tick) */
export async function pruneExternalCache(): Promise<number> {
    const result = await getLibrariesDb().prepare(`DELETE FROM rec_external_cache WHERE fetched_at < ?`).run(Date.now() - 4 * TTL_MS);
    return result.changes;
}
