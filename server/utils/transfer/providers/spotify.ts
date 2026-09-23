// Spotify Web API (https://developer.spotify.com/documentation/web-api), authorization code + PKCE.
// Only a client ID is required; a client secret is used as well when the operator provides one.
import type { ProviderSession, SourceAlbum, SourceArtist, SourceTrack, TransferProvider } from "../types";
import { str, num, transferFetch, transferPostForm, TransferHttpError } from "../http";

const API = "https://api.spotify.com/v1";
const API_HOSTS = ["api.spotify.com"];
const ACCOUNTS_HOSTS = ["accounts.spotify.com"];
const SCOPES = ["user-library-read", "playlist-read-private", "playlist-read-collaborative", "user-follow-read"];

interface Page<T> { items?: T[], next?: string | null, total?: number }

function config() {
    const c = useRuntimeConfig().transfer;
    return { clientId: c.spotifyClientId, clientSecret: c.spotifyClientSecret };
}

function get<T>(session: ProviderSession, url: string): Promise<T> {
    return transferFetch<T>(url, API_HOSTS, { headers: { Authorization: `Bearer ${session.accessToken}` } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collect<T>(session: ProviderSession, firstUrl: string, max: number, pick: (json: any) => Page<T>): Promise<T[]> {
    const out: T[] = [];
    let url: string | null | undefined = firstUrl;
    while (url && out.length < max) {
        const page = pick(await get(session, url));
        out.push(...(page.items ?? []));
        url = page.next;
    }
    return out.slice(0, max);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTrack(t: any): SourceTrack {
    // playlists can hold podcast episodes; nothing on Soulseek/MusicBrainz corresponds to those
    if (!t || t.type === "episode") {
        return { externalId: str(t?.id), title: str(t?.name), artist: str(t?.show?.name), album: null, isrc: null, durationMs: num(t?.duration_ms), unsupported: true };
    }
    return {
        externalId: str(t.id) ?? str(t.uri),
        title: str(t.name),
        artist: str(t.artists?.[0]?.name),
        album: str(t.album?.name),
        isrc: str(t.external_ids?.isrc),
        durationMs: num(t.duration_ms)
    };
}

export const spotifyProvider: TransferProvider = {
    id: "spotify",
    capabilities: { likedTracks: true, albums: true, artists: true, playlists: true },
    usesPkce: true,

    authModes: () => ["oauth"],
    isConfigured: () => !!config().clientId,

    authorizeUrl({ state, redirectUri, codeChallenge }) {
        const params = new URLSearchParams({
            client_id: config().clientId,
            response_type: "code",
            redirect_uri: redirectUri,
            code_challenge_method: "S256",
            code_challenge: codeChallenge,
            state,
            scope: SCOPES.join(" ")
        });
        return `https://accounts.spotify.com/authorize?${params}`;
    },

    async exchangeCode({ code, redirectUri, codeVerifier }) {
        const { clientId, clientSecret } = config();
        const headers: Record<string, string> = {};
        if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

        const json = await transferPostForm<{ access_token: string, expires_in?: number }>("https://accounts.spotify.com/api/token", ACCOUNTS_HOSTS, {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: codeVerifier
        }, headers);
        return { accessToken: json.access_token, expiresIn: json.expires_in ?? null };
    },

    async init(session) {
        const me = await get<{ id?: string, display_name?: string }>(session, `${API}/me`);
        session.data.account = str(me.display_name) ?? str(me.id) ?? "";
    },

    async overview(session) {
        const [liked, albums, artists, playlists] = await Promise.all([
            get<Page<unknown>>(session, `${API}/me/tracks?limit=1`).then((p) => p.total ?? null).catch(() => null),
            get<Page<unknown>>(session, `${API}/me/albums?limit=1`).then((p) => p.total ?? null).catch(() => null),
            get<{ artists?: Page<unknown> }>(session, `${API}/me/following?type=artist&limit=1`).then((p) => p.artists?.total ?? null).catch(() => null),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            collect<any>(session, `${API}/me/playlists?limit=50`, 2000, (json) => json)
        ]);

        return {
            account: session.data.account || null,
            likedTracks: liked,
            albums,
            artists,
            playlists: playlists.filter(Boolean).map((p) => ({
                id: String(p.id),
                title: str(p.name) ?? "Untitled",
                // the playlist object's "tracks" summary was renamed "items" in newer API versions - read both
                trackCount: num(p.items?.total) ?? num(p.tracks?.total),
                image: str(p.images?.[0]?.url)
            }))
        };
    },

    async likedTracks(session, max) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = await collect<any>(session, `${API}/me/tracks?limit=50`, max, (json) => json);
        return items.map((entry) => toTrack(entry?.track));
    },

    async albums(session, max) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = await collect<any>(session, `${API}/me/albums?limit=50`, max, (json) => json);
        return items.map((entry): SourceAlbum => ({
            externalId: str(entry?.album?.id),
            title: str(entry?.album?.name),
            artist: str(entry?.album?.artists?.[0]?.name),
            upc: str(entry?.album?.external_ids?.upc) ?? str(entry?.album?.external_ids?.ean)
        }));
    },

    async artists(session, max) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = await collect<any>(session, `${API}/me/following?type=artist&limit=50`, max, (json) => json.artists ?? {});
        return items.map((a): SourceArtist => ({ externalId: str(a?.id), name: str(a?.name) }));
    },

    async playlistTracks(session, playlistId, max) {
        const id = encodeURIComponent(playlistId);
        // "Get Playlist Items" moved from /tracks to /items; try the current path and fall back on a 404
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let items: any[];
        try {
            items = await collect(session, `${API}/playlists/${id}/items?limit=50`, max, (json) => json);
        } catch (err) {
            if (!(err instanceof TransferHttpError) || err.status !== 404) throw err;
            items = await collect(session, `${API}/playlists/${id}/tracks?limit=50`, max, (json) => json);
        }
        return items.map((entry) => toTrack(entry?.item ?? entry?.track));
    }
};
