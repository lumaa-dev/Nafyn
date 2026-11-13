// Last.fm scrobbling, server side: a user connects their Last.fm account once (the web auth flow, see
// /api/v1/user/lastfm/*), and every listen any client reports - the web player and the iOS app through
// POST /api/v1/insights/events, Subsonic apps through `scrobble` - is scrobbled from here. Independent of the
// listening history (insights): a user may scrobble with the history off.
//
// Fire-and-forget like notifications.ts: scrobbling never slows down or fails the request that reported the play.

import { getUsersDb } from "./db";
import { findPlayableEntry, getMediaId, type MediaRow } from "./library";
import { isScrobbleWorthy, LastfmApiError, scrobbleParams, signedCall, type ScrobbleTrack } from "../utils/lastfmApi";

export interface LastfmAccount {
    username: string,
    scrobbling: boolean,
    createdAt: number
}

interface LastfmRow {
    userId: string,
    username: string,
    sessionKey: string,
    scrobbling: number,
    createdAt: number
}

/** the instance can scrobble: both halves of a Last.fm API account are configured */
export function lastfmCredentials(): { apiKey: string, secret: string } | null {
    const config = useRuntimeConfig();
    const apiKey = String(config.lastfmApiKey ?? "").trim();
    const secret = String(config.lastfmApiSecret ?? "").trim();
    return apiKey && secret ? { apiKey, secret } : null;
}

async function getRow(userId: string): Promise<LastfmRow | null> {
    return await getUsersDb().prepare(`SELECT * FROM user_lastfm WHERE userId = ?`).get<LastfmRow>(userId) ?? null;
}

/** what the settings screens show: never the session key */
export async function getLastfmAccount(userId: string): Promise<LastfmAccount | null> {
    const row = await getRow(userId);
    return row ? { username: row.username, scrobbling: row.scrobbling === 1, createdAt: Number(row.createdAt) } : null;
}

export async function isScrobbling(userId: string): Promise<boolean> {
    if (!lastfmCredentials()) return false;
    const row = await getRow(userId);
    return row?.scrobbling === 1;
}

export async function saveLastfmAccount(userId: string, username: string, sessionKey: string): Promise<void> {
    await getUsersDb().prepare(`
        INSERT INTO user_lastfm (userId, username, sessionKey, scrobbling, createdAt)
        VALUES (?, ?, ?, 1, ?)
        ON DUPLICATE KEY UPDATE username = VALUES(username), sessionKey = VALUES(sessionKey), scrobbling = 1, createdAt = VALUES(createdAt)
    `).run(userId, username, sessionKey, Date.now());
}

export async function setLastfmScrobbling(userId: string, scrobbling: boolean): Promise<boolean> {
    const result = await getUsersDb().prepare(`UPDATE user_lastfm SET scrobbling = ? WHERE userId = ?`).run(scrobbling ? 1 : 0, userId);
    return result.changes > 0;
}

/** disconnect; also the erasure helper (eraseAccount) */
export async function deleteLastfmAccount(userId: string): Promise<boolean> {
    const result = await getUsersDb().prepare(`DELETE FROM user_lastfm WHERE userId = ?`).run(userId);
    return result.changes > 0;
}

/** auth.getSession: the token Last.fm handed back to the callback, for the session key and username */
export async function exchangeLastfmToken(token: string): Promise<{ username: string, sessionKey: string }> {
    const credentials = lastfmCredentials();
    if (!credentials) throw new LastfmApiError(null, "Last.fm is not configured");
    const result = await signedCall<{ session?: { name?: string, key?: string } }>("auth.getSession", { token }, credentials);
    const username = result.session?.name;
    const sessionKey = result.session?.key;
    if (!username || !sessionKey) throw new LastfmApiError(null, "Last.fm returned no session");
    return { username, sessionKey };
}

function toScrobble(media: MediaRow, startedAtMs: number): ScrobbleTrack {
    return {
        artist: media.artistName,
        track: media.title,
        album: media.album ?? null,
        timestamp: Math.floor(startedAtMs / 1000),
        duration: media.duration,
        trackNumber: media.trackNumber ?? null,
        // a manual import's id is not a MusicBrainz one
        mbid: media.source === "manual" ? null : media.musicbrainzId || null
    };
}

// a session Last.fm refuses (revoked from last.fm's settings) disconnects the account: every later call would fail too
async function handleFailure(userId: string, what: string, error: unknown): Promise<void> {
    if (error instanceof LastfmApiError && error.invalidSession) {
        console.log(`[lastfm] ${what}: Last.fm no longer accepts the session of user ${userId}, disconnecting it`);
        await deleteLastfmAccount(userId).catch(() => {});
        return;
    }
    console.error(`[lastfm] ${what} failed:`, error instanceof Error ? error.message : error);
}

export interface PlayToScrobble {
    trackId: string,
    startedAtMs: number,
    durationMs: number
}

/** scrobbles the plays Last.fm counts as listens; tracks the user can't play are skipped. Never throws. */
export function scrobblePlays(userId: string, plays: PlayToScrobble[]): void {
    if (plays.length === 0 || !lastfmCredentials()) return;
    void (async () => {
        const credentials = lastfmCredentials();
        const row = await getRow(userId);
        if (!credentials || !row || row.scrobbling !== 1) return;

        const tracks: ScrobbleTrack[] = [];
        for (const play of plays) {
            if (!(await findPlayableEntry(userId, play.trackId))) continue;
            const media = await getMediaId(play.trackId);
            if (!media || !isScrobbleWorthy(play.durationMs, media.duration)) continue;
            tracks.push(toScrobble(media, play.startedAtMs));
        }
        // Last.fm takes 50 per call
        for (let i = 0; i < tracks.length; i += 50) {
            await signedCall("track.scrobble", { ...scrobbleParams(tracks.slice(i, i + 50)), sk: row.sessionKey }, credentials, { post: true });
        }
    })().catch((error) => handleFailure(userId, "scrobble", error));
}

/** track.updateNowPlaying for a track the user just started. Never throws. */
export function sendNowPlaying(userId: string, mediaId: string): void {
    if (!lastfmCredentials()) return;
    void (async () => {
        const credentials = lastfmCredentials();
        const row = await getRow(userId);
        if (!credentials || !row || row.scrobbling !== 1) return;
        if (!(await findPlayableEntry(userId, mediaId))) return;
        const media = await getMediaId(mediaId);
        if (!media) return;

        const params: Record<string, string> = { artist: media.artistName, track: media.title, sk: row.sessionKey };
        if (media.album) params.album = media.album;
        if (media.duration > 0) params.duration = String(Math.round(media.duration));
        if (media.trackNumber) params.trackNumber = String(media.trackNumber);
        await signedCall("track.updateNowPlaying", params, credentials, { post: true });
    })().catch((error) => handleFailure(userId, "now playing", error));
}
