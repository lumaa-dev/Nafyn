// Last.fm's signed API calls (auth.getSession, track.scrobble, track.updateNowPlaying). Pure: no Nitro
// auto-imports, so `tests/lastfm.test.ts` runs under `bun test` - the network calls take their key, secret and
// fetch from the caller.

import { createHash } from "node:crypto";

export const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
export const LASTFM_AUTH_URL = "https://www.last.fm/api/auth/";

/** Last.fm's error codes that mean the session key is no good any more: the account has to be connected again */
export const LASTFM_INVALID_SESSION_ERRORS = new Set([4, 9, 14, 26]);

/**
 * api_sig (https://www.last.fm/api/authspec#_8-signing-calls): every parameter but `format` and `callback`,
 * sorted by name, name and value concatenated, the secret appended, md5 of the UTF-8 bytes.
 */
export function apiSignature(params: Record<string, string>, secret: string): string {
    const base = Object.keys(params)
        .filter((key) => key !== "format" && key !== "callback")
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("");
    return createHash("md5").update(base + secret, "utf8").digest("hex");
}

/**
 * Last.fm's scrobbling rule (https://www.last.fm/api/scrobbling#when-is-a-scrobble-a-scrobble): the track is longer
 * than 30 seconds, and was played for half its length or for 4 minutes, whichever comes first.
 */
export function isScrobbleWorthy(playedMs: number, trackSeconds: number): boolean {
    if (trackSeconds > 0 && trackSeconds <= 30) return false;
    if (playedMs >= 4 * 60 * 1000) return true;
    if (trackSeconds <= 0) return playedMs >= 30 * 1000;
    return playedMs >= (trackSeconds * 1000) / 2;
}

export interface ScrobbleTrack {
    artist: string,
    track: string,
    album: string | null,
    /** UNIX seconds the track started playing at */
    timestamp: number,
    /** seconds */
    duration: number,
    trackNumber: number | null,
    mbid: string | null
}

/** the array-indexed parameters of one track.scrobble call (at most 50 tracks) */
export function scrobbleParams(tracks: ScrobbleTrack[]): Record<string, string> {
    const params: Record<string, string> = {};
    tracks.slice(0, 50).forEach((track, i) => {
        params[`artist[${i}]`] = track.artist;
        params[`track[${i}]`] = track.track;
        params[`timestamp[${i}]`] = String(Math.floor(track.timestamp));
        if (track.album) params[`album[${i}]`] = track.album;
        if (track.duration > 0) params[`duration[${i}]`] = String(Math.round(track.duration));
        if (track.trackNumber) params[`trackNumber[${i}]`] = String(track.trackNumber);
        if (track.mbid) params[`mbid[${i}]`] = track.mbid;
    });
    return params;
}

export class LastfmApiError extends Error {
    constructor(readonly code: number | null, message: string) {
        super(message);
        this.name = "LastfmApiError";
    }

    get invalidSession(): boolean {
        return this.code !== null && LASTFM_INVALID_SESSION_ERRORS.has(this.code);
    }
}

/** one signed call; GET for reads, POST (form-encoded) for writes */
export async function signedCall<T>(
    method: string,
    params: Record<string, string>,
    credentials: { apiKey: string, secret: string },
    options: { post?: boolean, fetchImpl?: typeof fetch, timeoutMs?: number } = {}
): Promise<T> {
    const all: Record<string, string> = { ...params, method, api_key: credentials.apiKey };
    const body = new URLSearchParams({ ...all, api_sig: apiSignature(all, credentials.secret), format: "json" });
    const doFetch = options.fetchImpl ?? fetch;
    const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const response = options.post
        ? await doFetch(LASTFM_API_URL, { method: "POST", body, signal, headers: { "Content-Type": "application/x-www-form-urlencoded" } })
        : await doFetch(`${LASTFM_API_URL}?${body}`, { signal });
    const json = await response.json().catch(() => null) as ({ error?: number, message?: string } & T) | null;
    if (!json) throw new LastfmApiError(null, `Last.fm answered ${response.status}`);
    if (typeof json.error === "number") throw new LastfmApiError(json.error, json.message ?? `Last.fm error ${json.error}`);
    if (!response.ok) throw new LastfmApiError(null, `Last.fm answered ${response.status}`);
    return json;
}
