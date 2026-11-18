// ListenBrainz' core API (https://listenbrainz.readthedocs.io/en/latest/users/api/core.html): validate-token and
// submit-listens, for scrobbling. Pure: no Nitro auto-imports, so `tests/listenbrainz.test.ts` runs under
// `bun test` - the network calls take their token and fetch from the caller.
//
// A user connects with the user token from https://listenbrainz.org/settings/: no API key or secret on the
// instance, so scrobbling is available on every Nafyn server.

export const LISTENBRAINZ_API_URL = "https://api.listenbrainz.org";
export const LISTENBRAINZ_SETTINGS_URL = "https://listenbrainz.org/settings/";

/** one submit-listens call takes up to 1000 listens; batches stay well under it and its 10 MB payload cap */
export const LISTENS_PER_REQUEST = 100;

/**
 * ListenBrainz' listen rule (the same as every scrobbler's): the track was played for half its length or for
 * 4 minutes, whichever comes first. Tracks of 30 seconds or less are skipped, like before.
 */
export function isListenWorthy(playedMs: number, trackSeconds: number): boolean {
    if (trackSeconds > 0 && trackSeconds <= 30) return false;
    if (playedMs >= 4 * 60 * 1000) return true;
    if (trackSeconds <= 0) return playedMs >= 30 * 1000;
    return playedMs >= (trackSeconds * 1000) / 2;
}

export interface ListenTrack {
    artist: string,
    track: string,
    album: string | null,
    /** UNIX seconds the track started playing at */
    listenedAt: number,
    /** seconds */
    duration: number,
    trackNumber: number | null,
    /** MusicBrainz recording ID */
    recordingMbid: string | null,
    artistMbid: string | null
}

export type ListenType = "single" | "import" | "playing_now";

interface TrackMetadata {
    artist_name: string,
    track_name: string,
    release_name?: string,
    additional_info: Record<string, string | number | string[]>
}

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function trackMetadata(track: ListenTrack, client: { name: string, version: string }): TrackMetadata {
    const info: Record<string, string | number | string[]> = {
        submission_client: client.name,
        submission_client_version: client.version
    };
    if (track.duration > 0) info.duration_ms = Math.round(track.duration * 1000);
    if (track.trackNumber) info.tracknumber = track.trackNumber;
    if (track.recordingMbid && MBID_RE.test(track.recordingMbid)) info.recording_mbid = track.recordingMbid.toLowerCase();
    if (track.artistMbid && MBID_RE.test(track.artistMbid)) info.artist_mbids = [track.artistMbid.toLowerCase()];
    const metadata: TrackMetadata = { artist_name: track.artist, track_name: track.track, additional_info: info };
    if (track.album) metadata.release_name = track.album;
    return metadata;
}

/**
 * The body of one submit-listens call. `single` takes exactly one listen and `import` several; `playing_now`
 * takes one and no `listened_at`.
 */
export function listensPayload(tracks: ListenTrack[], client: { name: string, version: string }, nowPlaying = false): { listen_type: ListenType, payload: unknown[] } {
    if (nowPlaying) {
        const track = tracks[0];
        return { listen_type: "playing_now", payload: track ? [{ track_metadata: trackMetadata(track, client) }] : [] };
    }
    const listens = tracks.slice(0, LISTENS_PER_REQUEST).map((track) => ({
        listened_at: Math.floor(track.listenedAt),
        track_metadata: trackMetadata(track, client)
    }));
    return { listen_type: listens.length === 1 ? "single" : "import", payload: listens };
}

export class ListenBrainzApiError extends Error {
    constructor(readonly status: number | null, message: string) {
        super(message);
        this.name = "ListenBrainzApiError";
    }

    /** the token is no good any more (reset or deleted on listenbrainz.org): the account has to be connected again */
    get invalidToken(): boolean {
        return this.status === 401;
    }
}

interface CallOptions {
    fetchImpl?: typeof fetch,
    timeoutMs?: number,
    userAgent?: string
}

async function call<T>(path: string, token: string, init: { method: "GET" | "POST", body?: unknown }, options: CallOptions): Promise<T> {
    const doFetch = options.fetchImpl ?? fetch;
    const headers: Record<string, string> = { Authorization: `Token ${token}`, Accept: "application/json" };
    if (options.userAgent) headers["User-Agent"] = options.userAgent;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await doFetch(`${LISTENBRAINZ_API_URL}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        redirect: "error"
    });
    const json = await response.json().catch(() => null) as ({ error?: string } & T) | null;
    if (!response.ok) throw new ListenBrainzApiError(response.status, json?.error ?? `ListenBrainz answered ${response.status}`);
    if (!json) throw new ListenBrainzApiError(response.status, `ListenBrainz answered ${response.status} without a body`);
    return json;
}

/** validate-token: the ListenBrainz username the token belongs to, or null when it is not a valid token */
export async function validateToken(token: string, options: CallOptions = {}): Promise<string | null> {
    const result = await call<{ valid?: boolean, user_name?: string }>("/1/validate-token", token, { method: "GET" }, options);
    return result.valid === true && typeof result.user_name === "string" && result.user_name ? result.user_name : null;
}

/** one submit-listens call (see listensPayload) */
export async function submitListens(token: string, body: { listen_type: ListenType, payload: unknown[] }, options: CallOptions = {}): Promise<void> {
    if (body.payload.length === 0) return;
    await call("/1/submit-listens", token, { method: "POST", body }, options);
}
