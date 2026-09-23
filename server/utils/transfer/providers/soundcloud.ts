// SoundCloud API (https://developers.soundcloud.com/docs/api/guide), OAuth 2.1 authorization code + PKCE.
// SoundCloud rarely exposes an ISRC (only for some label-distributed tracks, under publisher_metadata), so
// most of these are matched by title/artist search.
import type { ProviderSession, SourceArtist, SourceTrack, TransferProvider } from "../types";
import { num, str, transferFetch, transferPostForm } from "../http";
import { splitArtistTitle } from "../titles";

const API = "https://api.soundcloud.com";
const API_HOSTS = ["api.soundcloud.com"];
const AUTH_HOSTS = ["secure.soundcloud.com"];

function config() {
    const c = useRuntimeConfig().transfer;
    return { clientId: c.soundcloudClientId, clientSecret: c.soundcloudClientSecret };
}

function get<T>(session: ProviderSession, url: string): Promise<T> {
    return transferFetch<T>(url, API_HOSTS, { headers: { Authorization: `OAuth ${session.accessToken}`, Accept: "application/json; charset=utf-8" } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collect(session: ProviderSession, firstUrl: string, max: number): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = [];
    let url: string | undefined = firstUrl;
    while (url && out.length < max) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = await get(session, url);
        // linked_partitioning responses are { collection, next_href }, older ones a bare array
        const page = Array.isArray(json) ? json : json?.collection ?? [];
        out.push(...page);
        url = !Array.isArray(json) && typeof json?.next_href === "string" ? json.next_href : undefined;
    }
    return out.slice(0, max);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTrack(t: any): SourceTrack {
    const meta = t?.publisher_metadata ?? {};
    let title = str(t?.title);
    let artist = str(meta.artist);

    // uploads without label metadata are usually titled "Artist - Title" by whoever uploaded them
    if (!artist && title) {
        const split = splitArtistTitle(title);
        if (split) ({ artist, title } = split);
        else artist = str(t?.user?.username);
    }

    return {
        externalId: str(t?.urn) ?? str(t?.id),
        title,
        artist,
        album: str(meta.album_title) ?? str(meta.release_title),
        isrc: str(meta.isrc) ?? str(t?.isrc),
        durationMs: num(t?.full_duration) ?? num(t?.duration),
        unsupported: t?.kind !== undefined && t.kind !== "track"
    };
}

export const soundcloudProvider: TransferProvider = {
    id: "soundcloud",
    capabilities: { likedTracks: true, albums: false, artists: true, playlists: true },
    usesPkce: true,

    authModes: () => ["oauth"],
    isConfigured() {
        const { clientId, clientSecret } = config();
        return !!(clientId && clientSecret);
    },

    authorizeUrl({ state, redirectUri, codeChallenge }) {
        const params = new URLSearchParams({
            client_id: config().clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            state
        });
        return `https://secure.soundcloud.com/authorize?${params}`;
    },

    async exchangeCode({ code, redirectUri, codeVerifier }) {
        const { clientId, clientSecret } = config();
        const json = await transferPostForm<{ access_token: string, expires_in?: number }>("https://secure.soundcloud.com/oauth/token", AUTH_HOSTS, {
            grant_type: "authorization_code",
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
            code
        });
        return { accessToken: json.access_token, expiresIn: json.expires_in ?? null };
    },

    async init(session) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const me = await get<any>(session, `${API}/me`);
        session.data.account = str(me?.full_name) ?? str(me?.username) ?? "";
        session.data.likes = String(num(me?.public_favorites_count) ?? num(me?.likes_count) ?? "");
        session.data.followings = String(num(me?.followings_count) ?? "");
    },

    async overview(session) {
        const playlists = await collect(session, `${API}/me/playlists?limit=50&linked_partitioning=true&show_tracks=false`, 2000);
        return {
            account: session.data.account || null,
            likedTracks: num(session.data.likes),
            albums: null,
            artists: num(session.data.followings),
            playlists: playlists.map((p) => ({
                id: String(p?.urn ?? p?.id),
                title: str(p?.title) ?? "Untitled",
                trackCount: num(p?.track_count),
                image: str(p?.artwork_url)
            }))
        };
    },

    async likedTracks(session, max) {
        const items = await collect(session, `${API}/me/likes/tracks?limit=200&linked_partitioning=true`, max);
        return items.map(toTrack);
    },

    async artists(session, max) {
        const users = await collect(session, `${API}/me/followings?limit=200&linked_partitioning=true`, max);
        return users.map((u): SourceArtist => ({ externalId: str(u?.urn) ?? str(u?.id), name: str(u?.username) }));
    },

    async playlistTracks(session, playlistId, max) {
        const items = await collect(session, `${API}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=200&linked_partitioning=true`, max);
        return items.map(toTrack);
    }
};
