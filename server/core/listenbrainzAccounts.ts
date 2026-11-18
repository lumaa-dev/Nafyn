// ListenBrainz scrobbling, server side: a user connects their ListenBrainz account once with its user token (see
// /api/v1/user/listenbrainz/*), and every listen any client reports - the web player and the iOS app through
// POST /api/v1/insights/events, Subsonic apps through `scrobble` - is submitted from here. Independent of the
// listening history (insights): a user may scrobble with the history off.
//
// Fire-and-forget like notifications.ts: scrobbling never slows down or fails the request that reported the play.

import { getUsersDb } from "./db";
import { findPlayableEntry, getMediaId, type MediaRow } from "./library";
import { APP_NAME, APP_VERSION, USER_AGENT } from "../utils/app";
import {
    isListenWorthy, ListenBrainzApiError, listensPayload, LISTENS_PER_REQUEST, submitListens, validateToken,
    type ListenTrack
} from "../utils/listenbrainzApi";

export interface ListenBrainzAccount {
    username: string,
    scrobbling: boolean,
    createdAt: number
}

interface ListenBrainzRow {
    userId: string,
    username: string,
    token: string,
    scrobbling: number,
    createdAt: number
}

const CLIENT = { name: APP_NAME, version: APP_VERSION };

async function getRow(userId: string): Promise<ListenBrainzRow | null> {
    return await getUsersDb().prepare(`SELECT * FROM user_listenbrainz WHERE userId = ?`).get<ListenBrainzRow>(userId) ?? null;
}

/** what the settings screens show: never the token */
export async function getListenBrainzAccount(userId: string): Promise<ListenBrainzAccount | null> {
    const row = await getRow(userId);
    return row ? { username: row.username, scrobbling: row.scrobbling === 1, createdAt: Number(row.createdAt) } : null;
}

export async function isScrobbling(userId: string): Promise<boolean> {
    const row = await getRow(userId);
    return row?.scrobbling === 1;
}

/**
 * Checks the token with ListenBrainz and stores it, scrobbling on. Returns the account, or null when ListenBrainz
 * says the token is not valid; throws a ListenBrainzApiError when ListenBrainz couldn't be asked.
 */
export async function connectListenBrainz(userId: string, token: string): Promise<ListenBrainzAccount | null> {
    const username = await validateToken(token, { userAgent: USER_AGENT });
    if (!username) return null;
    const createdAt = Date.now();
    await getUsersDb().prepare(`
        INSERT INTO user_listenbrainz (userId, username, token, scrobbling, createdAt)
        VALUES (?, ?, ?, 1, ?)
        ON DUPLICATE KEY UPDATE username = VALUES(username), token = VALUES(token), scrobbling = 1, createdAt = VALUES(createdAt)
    `).run(userId, username, token, createdAt);
    return { username, scrobbling: true, createdAt };
}

export async function setListenBrainzScrobbling(userId: string, scrobbling: boolean): Promise<boolean> {
    const result = await getUsersDb().prepare(`UPDATE user_listenbrainz SET scrobbling = ? WHERE userId = ?`).run(scrobbling ? 1 : 0, userId);
    return result.changes > 0;
}

/** disconnect; also the erasure helper (eraseAccount) */
export async function deleteListenBrainzAccount(userId: string): Promise<boolean> {
    const result = await getUsersDb().prepare(`DELETE FROM user_listenbrainz WHERE userId = ?`).run(userId);
    return result.changes > 0;
}

function toListen(media: MediaRow, startedAtMs: number): ListenTrack {
    // a manual import's ids are not MusicBrainz ones
    const fromMusicBrainz = media.source !== "manual";
    return {
        artist: media.artistName,
        track: media.title,
        album: media.album ?? null,
        listenedAt: Math.floor(startedAtMs / 1000),
        duration: media.duration,
        trackNumber: media.trackNumber ?? null,
        recordingMbid: fromMusicBrainz ? media.musicbrainzId || null : null,
        artistMbid: fromMusicBrainz ? media.artistMbid || null : null
    };
}

// a token ListenBrainz refuses (reset or deleted on listenbrainz.org) disconnects the account: every later call would fail too
async function handleFailure(userId: string, what: string, error: unknown): Promise<void> {
    if (error instanceof ListenBrainzApiError && error.invalidToken) {
        console.log(`[listenbrainz] ${what}: ListenBrainz no longer accepts the token of user ${userId}, disconnecting it`);
        await deleteListenBrainzAccount(userId).catch(() => {});
        return;
    }
    console.error(`[listenbrainz] ${what} failed:`, error instanceof Error ? error.message : error);
}

export interface PlayToScrobble {
    trackId: string,
    startedAtMs: number,
    durationMs: number
}

/** submits the plays ListenBrainz counts as listens; tracks the user can't play are skipped. Never throws. */
export function scrobblePlays(userId: string, plays: PlayToScrobble[]): void {
    if (plays.length === 0) return;
    void (async () => {
        const row = await getRow(userId);
        if (!row || row.scrobbling !== 1) return;

        // each play is checked on its own: side by side, order kept by Promise.all
        const checked = await Promise.all(plays.map(async (play): Promise<ListenTrack | null> => {
            if (!(await findPlayableEntry(userId, play.trackId))) return null;
            const media = await getMediaId(play.trackId);
            if (!media || !isListenWorthy(play.durationMs, media.duration)) return null;
            return toListen(media, play.startedAtMs);
        }));
        const listens = checked.filter((listen): listen is ListenTrack => listen !== null);
        for (let i = 0; i < listens.length; i += LISTENS_PER_REQUEST) {
            await submitListens(row.token, listensPayload(listens.slice(i, i + LISTENS_PER_REQUEST), CLIENT), { userAgent: USER_AGENT });
        }
    })().catch((error) => handleFailure(userId, "scrobble", error));
}

/** a `playing_now` listen for a track the user just started. Never throws. */
export function sendNowPlaying(userId: string, mediaId: string): void {
    void (async () => {
        const row = await getRow(userId);
        if (!row || row.scrobbling !== 1) return;
        if (!(await findPlayableEntry(userId, mediaId))) return;
        const media = await getMediaId(mediaId);
        if (!media) return;
        await submitListens(row.token, listensPayload([toListen(media, Date.now())], CLIENT, true), { userAgent: USER_AGENT });
    })().catch((error) => handleFailure(userId, "now playing", error));
}
