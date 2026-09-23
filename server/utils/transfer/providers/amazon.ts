// Amazon Music Web API (https://developer.amazon.com/docs/music/API_web_overview.html), signed in through
// Login with Amazon (authorization code). The Web API is a closed beta: it only works with a security
// profile Amazon has approved for it, whose id is sent as `x-api-key` on every call.
//
// Responses are GraphQL-shaped ({ data: { user: { playlists: { edges: [{ node }], pageInfo } } } }), so
// list reading walks down to the first `edges` array rather than hardcoding every path.
import type { ProviderSession, SourceTrack, TransferProvider } from "../types";
import { isoDurationToMs, num, str, transferFetch, transferPostForm } from "../http";

const API = "https://api.music.amazon.dev/v1";
const API_HOSTS = ["api.music.amazon.dev"];
const TOKEN_HOSTS = ["api.amazon.com"];
const SCOPES = ["profile", "music::library", "music::playlist"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function config() {
    const c = useRuntimeConfig().transfer;
    return { clientId: c.amazonClientId, clientSecret: c.amazonClientSecret, apiKey: c.amazonApiKey };
}

function get<T>(session: ProviderSession, url: string): Promise<T> {
    return transferFetch<T>(url, API_HOSTS, {
        headers: { Authorization: `Bearer ${session.accessToken}`, "x-api-key": config().apiKey, Accept: "application/json" }
    });
}

// depth-first search for the first { edges, pageInfo } connection in a response
function findConnection(json: Json, depth = 0): { edges: Json[], pageInfo?: Json } | null {
    if (!json || typeof json !== "object" || depth > 6) return null;
    if (Array.isArray(json.edges)) return json;
    for (const value of Object.values(json)) {
        const found = findConnection(value, depth + 1);
        if (found) return found;
    }
    return null;
}

async function collect(session: ProviderSession, path: string, max: number): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | null = null;
    do {
        const sep = path.includes("?") ? "&" : "?";
        const url = `${API}${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const connection = findConnection(await get<Json>(session, url));
        if (!connection) break;
        out.push(...connection.edges.map((e: Json) => e?.node ?? e));
        cursor = connection.pageInfo?.hasNextPage ? str(connection.pageInfo?.token) ?? str(connection.pageInfo?.endCursor) : null;
    } while (cursor && out.length < max);
    return out.slice(0, max);
}

function toTrack(t: Json): SourceTrack {
    const artist = Array.isArray(t?.artists) ? t.artists[0]?.name : t?.artist?.name ?? t?.artistName;
    return {
        externalId: str(t?.id),
        title: str(t?.title),
        artist: str(artist),
        album: str(t?.album?.title),
        isrc: str(t?.isrc),
        durationMs: typeof t?.duration === "string" ? isoDurationToMs(t.duration) : num(t?.duration) !== null ? num(t.duration)! * 1000 : null
    };
}

export const amazonProvider: TransferProvider = {
    id: "amazon",
    capabilities: { likedTracks: true, albums: false, artists: false, playlists: true },

    authModes: () => ["oauth"],
    isConfigured() {
        const { clientId, clientSecret, apiKey } = config();
        return !!(clientId && clientSecret && apiKey);
    },

    authorizeUrl({ state, redirectUri }) {
        const params = new URLSearchParams({ client_id: config().clientId, scope: SCOPES.join(" "), response_type: "code", redirect_uri: redirectUri, state });
        return `https://www.amazon.com/ap/oa?${params}`;
    },

    async exchangeCode({ code, redirectUri }) {
        const { clientId, clientSecret } = config();
        const json = await transferPostForm<{ access_token: string, expires_in?: number }>("https://api.amazon.com/auth/o2/token", TOKEN_HOSTS, {
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret
        });
        return { accessToken: json.access_token, expiresIn: json.expires_in ?? null };
    },

    async overview(session) {
        const playlists = await collect(session, "/me/playlists", 2000);
        return {
            account: null,
            likedTracks: null,
            albums: null,
            artists: null,
            playlists: playlists.map((p) => ({
                id: String(p?.id),
                title: str(p?.title) ?? "Untitled",
                trackCount: num(p?.trackCount),
                image: str(p?.images?.[0]?.url)
            }))
        };
    },

    async likedTracks(session, max) {
        return (await collect(session, "/me/tracks", max)).map(toTrack);
    },

    async playlistTracks(session, playlistId, max) {
        return (await collect(session, `/playlists/${encodeURIComponent(playlistId)}/tracks`, max)).map(toTrack);
    }
};
