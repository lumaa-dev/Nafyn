// YouTube Music, through the YouTube Data API v3 (https://developers.google.com/youtube/v3) with a Google
// OAuth web client (authorization code + PKCE). YouTube Music has no public API of its own: its playlists
// are YouTube playlists, its likes land in the account's "Liked videos" list, and followed artists are
// channel subscriptions. Videos carry no ISRC, so everything here is matched by title/artist search.
import type { ProviderSession, SourceArtist, SourceTrack, TransferProvider } from "../types";
import { chunk, isoDurationToMs, num, str, transferFetch, transferPostForm } from "../http";
import { cleanChannelName, splitArtistTitle, stripVideoNoise } from "../titles";

const API = "https://www.googleapis.com/youtube/v3";
const API_HOSTS = ["www.googleapis.com"];
const TOKEN_HOSTS = ["oauth2.googleapis.com"];
const UNAVAILABLE_TITLES = new Set(["Deleted video", "Private video"]);

function config() {
    const c = useRuntimeConfig().transfer;
    return { clientId: c.googleClientId, clientSecret: c.googleClientSecret };
}

function get<T>(session: ProviderSession, url: string): Promise<T> {
    return transferFetch<T>(url, API_HOSTS, { headers: { Authorization: `Bearer ${session.accessToken}` } });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collect(session: ProviderSession, baseUrl: string, max: number): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = [];
    let pageToken: string | undefined;
    do {
        const url = pageToken ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}` : baseUrl;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = await get(session, url);
        out.push(...(json?.items ?? []));
        pageToken = str(json?.nextPageToken) ?? undefined;
    } while (pageToken && out.length < max);
    return out.slice(0, max);
}

async function playlistItems(session: ProviderSession, playlistId: string, max: number): Promise<SourceTrack[]> {
    const items = await collect(session, `${API}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlistId)}`, max);

    // durations aren't on playlist items; one videos.list call per 50 fills them in and sharpens matching
    const videoIds = items.map((i) => str(i?.contentDetails?.videoId)).filter((id): id is string => !!id);
    const durations = new Map<string, number>();
    for (const ids of chunk([...new Set(videoIds)], 50)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = await get<any>(session, `${API}/videos?part=contentDetails&id=${ids.map(encodeURIComponent).join(",")}`).catch(() => ({ items: [] }));
        for (const v of json?.items ?? []) {
            const ms = isoDurationToMs(v?.contentDetails?.duration);
            if (ms) durations.set(v.id, ms);
        }
    }

    return items.map((item): SourceTrack => {
        const videoId = str(item?.contentDetails?.videoId);
        const rawTitle = str(item?.snippet?.title) ?? "";
        const channel = str(item?.snippet?.videoOwnerChannelTitle) ?? "";

        if (!rawTitle || UNAVAILABLE_TITLES.has(rawTitle) || !channel) {
            return { externalId: videoId, title: rawTitle || null, artist: null, album: null, isrc: null, durationMs: null, unsupported: true };
        }

        const cleaned = stripVideoNoise(rawTitle);
        let artist: string | null;
        let title: string | null;
        if (/\s-\sTopic$/i.test(channel)) {
            // auto-generated "Artist - Topic" uploads: the title is exactly the track title
            artist = cleanChannelName(channel);
            title = cleaned;
        } else {
            const split = splitArtistTitle(cleaned);
            artist = split?.artist ?? cleanChannelName(channel);
            title = split?.title ?? cleaned;
        }

        return { externalId: videoId, title, artist, album: null, isrc: null, durationMs: videoId ? durations.get(videoId) ?? null : null };
    });
}

export const youtubeProvider: TransferProvider = {
    id: "youtube",
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
            scope: "https://www.googleapis.com/auth/youtube.readonly",
            access_type: "online",
            include_granted_scopes: "true",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            state
        });
        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },

    async exchangeCode({ code, redirectUri, codeVerifier }) {
        const { clientId, clientSecret } = config();
        const json = await transferPostForm<{ access_token: string, expires_in?: number }>("https://oauth2.googleapis.com/token", TOKEN_HOSTS, {
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier
        });
        return { accessToken: json.access_token, expiresIn: json.expires_in ?? null };
    },

    async init(session) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = await get<any>(session, `${API}/channels?part=snippet,contentDetails&mine=true`);
        const channel = json?.items?.[0];
        session.data.account = str(channel?.snippet?.title) ?? "";
        session.data.likes = str(channel?.contentDetails?.relatedPlaylists?.likes) ?? "LL";
    },

    async overview(session) {
        const count = (url: string) => get<{ pageInfo?: { totalResults?: number } }>(session, url).then((j) => num(j.pageInfo?.totalResults)).catch(() => null);
        const [likedTracks, artists, playlists] = await Promise.all([
            count(`${API}/playlistItems?part=id&maxResults=1&playlistId=${encodeURIComponent(session.data.likes ?? "LL")}`),
            count(`${API}/subscriptions?part=id&mine=true&maxResults=1`),
            collect(session, `${API}/playlists?part=snippet,contentDetails&mine=true&maxResults=50`, 2000)
        ]);

        return {
            account: session.data.account || null,
            likedTracks,
            albums: null,
            artists,
            playlists: playlists.map((p) => ({
                id: String(p?.id),
                title: str(p?.snippet?.title) ?? "Untitled",
                trackCount: num(p?.contentDetails?.itemCount),
                image: str(p?.snippet?.thumbnails?.default?.url)
            }))
        };
    },

    async likedTracks(session, max) {
        return await playlistItems(session, session.data.likes ?? "LL", max);
    },

    async artists(session, max) {
        const subs = await collect(session, `${API}/subscriptions?part=snippet&mine=true&maxResults=50`, max);
        return subs.map((s): SourceArtist => {
            const name = str(s?.snippet?.title);
            return { externalId: str(s?.snippet?.resourceId?.channelId), name: name ? cleanChannelName(name) : null };
        });
    },

    async playlistTracks(session, playlistId, max) {
        return await playlistItems(session, playlistId, max);
    }
};
