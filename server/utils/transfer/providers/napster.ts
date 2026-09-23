// Napster API v2.2 (https://www.napster.com/developer), authorization code grant with an API key + secret.
// Napster tracks and albums carry ISRCs/UPCs, so matching is mostly exact.
import type { ProviderSession, SourceAlbum, SourceArtist, SourceTrack, TransferProvider } from "../types";
import { num, str, transferFetch, transferPostForm } from "../http";

const API = "https://api.napster.com/v2.2";
const API_HOSTS = ["api.napster.com"];
const PAGE = 200;

function config() {
    const c = useRuntimeConfig().transfer;
    return { apiKey: c.napsterApiKey, apiSecret: c.napsterApiSecret };
}

function get<T>(session: ProviderSession, url: string): Promise<T> {
    return transferFetch<T>(url, API_HOSTS, { headers: { Authorization: `Bearer ${session.accessToken}` } });
}

// offset-paged: { <key>: [...], meta: { totalCount } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collect(session: ProviderSession, path: string, key: string, max: number): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = [];
    for (let offset = 0; out.length < max; offset += PAGE) {
        const sep = path.includes("?") ? "&" : "?";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = await get(session, `${API}${path}${sep}limit=${PAGE}&offset=${offset}`);
        const page = json?.[key] ?? [];
        out.push(...page);
        if (page.length < PAGE) break;
    }
    return out.slice(0, max);
}

async function total(session: ProviderSession, path: string): Promise<number | null> {
    return get<{ meta?: { totalCount?: number } }>(session, `${API}${path}?limit=1`).then((j) => num(j.meta?.totalCount)).catch(() => null);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTrack(t: any): SourceTrack {
    return {
        externalId: str(t?.id),
        title: str(t?.name),
        artist: str(t?.artistName),
        album: str(t?.albumName),
        isrc: str(t?.isrc),
        durationMs: num(t?.playbackSeconds) !== null ? num(t.playbackSeconds)! * 1000 : null
    };
}

export const napsterProvider: TransferProvider = {
    id: "napster",
    capabilities: { likedTracks: true, albums: true, artists: true, playlists: true },

    authModes: () => ["oauth"],
    isConfigured() {
        const { apiKey, apiSecret } = config();
        return !!(apiKey && apiSecret);
    },

    authorizeUrl({ state, redirectUri }) {
        const params = new URLSearchParams({ client_id: config().apiKey, redirect_uri: redirectUri, response_type: "code", state });
        return `https://api.napster.com/oauth/authorize?${params}`;
    },

    async exchangeCode({ code, redirectUri }) {
        const { apiKey, apiSecret } = config();
        const json = await transferPostForm<{ access_token: string, expires_in?: number }>("https://api.napster.com/oauth/access_token", API_HOSTS, {
            client_id: apiKey,
            client_secret: apiSecret,
            response_type: "code",
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
            code
        });
        return { accessToken: json.access_token, expiresIn: json.expires_in ?? null };
    },

    async init(session) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = await get<any>(session, `${API}/me/account`).catch(() => null);
        session.data.account = str(json?.account?.screenName) ?? str(json?.account?.firstName) ?? "";
    },

    async overview(session) {
        const [likedTracks, albums, artists, playlists] = await Promise.all([
            total(session, "/me/library/tracks"),
            total(session, "/me/library/albums"),
            total(session, "/me/library/artists"),
            collect(session, "/me/library/playlists", "playlists", 2000)
        ]);
        return {
            account: session.data.account || null,
            likedTracks,
            albums,
            artists,
            playlists: playlists.map((p) => ({ id: String(p?.id), title: str(p?.name) ?? "Untitled", trackCount: num(p?.trackCount), image: null }))
        };
    },

    async likedTracks(session, max) {
        return (await collect(session, "/me/library/tracks", "tracks", max)).map(toTrack);
    },

    async albums(session, max) {
        const albums = await collect(session, "/me/library/albums", "albums", max);
        return albums.map((a): SourceAlbum => ({ externalId: str(a?.id), title: str(a?.name), artist: str(a?.artistName), upc: str(a?.upc) }));
    },

    async artists(session, max) {
        const artists = await collect(session, "/me/library/artists", "artists", max);
        return artists.map((a): SourceArtist => ({ externalId: str(a?.id), name: str(a?.name) }));
    },

    async playlistTracks(session, playlistId, max) {
        return (await collect(session, `/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, "tracks", max)).map(toTrack);
    }
};
