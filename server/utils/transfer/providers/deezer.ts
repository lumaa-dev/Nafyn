// Deezer API (https://developers.deezer.com/api).
//
// Two ways in: OAuth, when the operator has a Deezer app (DEEZER_APP_ID/DEEZER_APP_SECRET - Deezer stopped
// accepting new app registrations, so most installs won't), or a public profile link, which reads whatever
// that profile shows publicly (favourites, albums, artists and public playlists) with no sign-in at all.
import type { ProviderSession, SourceAlbum, SourceArtist, SourceTrack, TransferProvider } from "../types";
import { num, str, transferFetch, transferSleep, TransferHttpError } from "../http";

const API = "https://api.deezer.com";
const API_HOSTS = ["api.deezer.com"];
const CONNECT_HOSTS = ["connect.deezer.com"];
const PROFILE_HOSTS = ["www.deezer.com", "deezer.com", "link.deezer.com", "deezer.page.link"];
// Deezer allows 50 requests / 5 seconds per client; per-item detail lookups stay comfortably under that
const DETAIL_DELAY_MS = 120;

function config() {
    const c = useRuntimeConfig().transfer;
    return { appId: c.deezerAppId, secret: c.deezerAppSecret };
}

function withToken(session: ProviderSession, url: string): string {
    if (!session.accessToken) return url;
    const u = new URL(url);
    u.searchParams.set("access_token", session.accessToken);
    return u.toString();
}

// Deezer reports most errors (quota included) as HTTP 200 with an `error` object
async function get<T>(session: ProviderSession, url: string, attempt = 0): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await transferFetch<any>(withToken(session, url), API_HOSTS);
    if (json?.error) {
        if (json.error.code === 4 && attempt < 5) {
            await transferSleep(5000);
            return get<T>(session, url, attempt + 1);
        }
        const status = json.error.code === 800 ? 404 : 400;
        throw new TransferHttpError(status, "api.deezer.com", str(json.error.message) ?? "error");
    }
    return json as T;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function collect(session: ProviderSession, firstUrl: string, max: number): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any[] = [];
    let url: string | undefined = firstUrl;
    while (url && out.length < max) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: { data?: any[], next?: string } = await get(session, url);
        out.push(...(json.data ?? []));
        url = typeof json.next === "string" ? json.next : undefined;
    }
    return out.slice(0, max);
}

function user(session: ProviderSession): string {
    return encodeURIComponent(session.data.userRef ?? "me");
}

async function total(session: ProviderSession, path: string): Promise<number | null> {
    return get<{ total?: number }>(session, `${API}${path}`).then((json) => num(json.total)).catch(() => null);
}

// list endpoints return a trimmed track object; the ISRC is only on the full /track/{id} one
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toTracks(session: ProviderSession, items: any[]): Promise<SourceTrack[]> {
    const out: SourceTrack[] = [];
    for (const t of items) {
        let isrc = str(t?.isrc);
        if (!isrc && t?.id && t?.type !== "episode") {
            await transferSleep(DETAIL_DELAY_MS);
            isrc = await get<{ isrc?: string }>(session, `${API}/track/${encodeURIComponent(String(t.id))}`).then((full) => str(full.isrc)).catch(() => null);
        }
        out.push({
            externalId: str(t?.id),
            title: str(t?.title),
            artist: str(t?.artist?.name),
            album: str(t?.album?.title),
            isrc,
            durationMs: num(t?.duration) !== null ? num(t.duration)! * 1000 : null,
            unsupported: t?.type === "episode"
        });
    }
    return out;
}

// accepts a bare numeric id, a https://www.deezer.com/<lang>/profile/<id> URL, or a deezer.page.link /
// link.deezer.com share link (resolved by following its redirect, one allowlisted hop at a time)
export async function resolveDeezerProfile(input: string): Promise<string | null> {
    const value = input.trim();
    if (/^\d{1,20}$/.test(value)) return value;

    let current: URL;
    try {
        current = new URL(value);
    } catch {
        return null;
    }

    for (let hop = 0; hop < 4; hop++) {
        if (current.protocol !== "https:" || !PROFILE_HOSTS.includes(current.hostname)) return null;

        const match = /\/profile\/(\d{1,20})/.exec(current.pathname);
        if (match) return match[1]!;
        if (current.hostname === "www.deezer.com" || current.hostname === "deezer.com") return null;

        // SECURITY: short-link hosts only; redirects are followed by hand so every hop is re-checked
        const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
        const location = res?.headers.get("location");
        if (!location) return null;
        current = new URL(location, current);
    }
    return null;
}

export const deezerProvider: TransferProvider = {
    id: "deezer",
    capabilities: { likedTracks: true, albums: true, artists: true, playlists: true },

    authModes() {
        const { appId, secret } = config();
        return appId && secret ? ["oauth", "profile"] : ["profile"];
    },
    isConfigured: () => true,

    // Deezer doesn't document a `state` parameter, so it rides along inside the redirect URI instead
    authorizeUrl({ state, redirectUri }) {
        const redirect = `${redirectUri}?state=${encodeURIComponent(state)}`;
        const params = new URLSearchParams({ app_id: config().appId, redirect_uri: redirect, perms: "basic_access,offline_access" });
        return `https://connect.deezer.com/oauth/auth.php?${params}`;
    },

    async exchangeCode({ code }) {
        const { appId, secret } = config();
        const params = new URLSearchParams({ app_id: appId, secret, code, output: "json" });
        const json = await transferFetch<{ access_token?: string, expires?: number }>(`https://connect.deezer.com/oauth/access_token.php?${params}`, CONNECT_HOSTS);
        if (!json.access_token) throw new Error("Deezer refused the authorization code");
        return { accessToken: json.access_token, expiresIn: num(json.expires) || null };
    },

    async init(session) {
        const me = await get<{ id?: number, name?: string }>(session, `${API}/user/${user(session)}`);
        if (!me.id) throw new TransferHttpError(404, "api.deezer.com", "profile not found");
        session.data.userRef = String(me.id);
        session.data.account = str(me.name) ?? "";
    },

    async overview(session) {
        const u = user(session);
        const [likedTracks, albums, artists, playlists] = await Promise.all([
            total(session, `/user/${u}/tracks?limit=1`),
            total(session, `/user/${u}/albums?limit=1`),
            total(session, `/user/${u}/artists?limit=1`),
            collect(session, `${API}/user/${u}/playlists?limit=100`, 2000)
        ]);

        return {
            account: session.data.account || null,
            likedTracks,
            albums,
            artists,
            playlists: playlists
                // the "Loved tracks" playlist mirrors the favourites, which are offered separately
                .filter((p) => !p?.is_loved_track)
                .map((p) => ({ id: String(p.id), title: str(p.title) ?? "Untitled", trackCount: num(p.nb_tracks), image: str(p.picture_medium) }))
        };
    },

    async likedTracks(session, max) {
        return await toTracks(session, await collect(session, `${API}/user/${user(session)}/tracks?limit=100`, max));
    },

    async albums(session, max) {
        const items = await collect(session, `${API}/user/${user(session)}/albums?limit=100`, max);
        const out: SourceAlbum[] = [];
        for (const a of items) {
            let upc = str(a?.upc);
            if (!upc && a?.id) {
                await transferSleep(DETAIL_DELAY_MS);
                upc = await get<{ upc?: string }>(session, `${API}/album/${encodeURIComponent(String(a.id))}`).then((full) => str(full.upc)).catch(() => null);
            }
            out.push({ externalId: str(a?.id), title: str(a?.title), artist: str(a?.artist?.name), upc });
        }
        return out;
    },

    async artists(session, max) {
        const items = await collect(session, `${API}/user/${user(session)}/artists?limit=100`, max);
        return items.map((a): SourceArtist => ({ externalId: str(a?.id), name: str(a?.name) }));
    },

    async playlistTracks(session, playlistId, max) {
        return await toTracks(session, await collect(session, `${API}/playlist/${encodeURIComponent(playlistId)}/tracks?limit=100`, max));
    }
};
