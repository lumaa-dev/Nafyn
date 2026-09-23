// Apple Music API (https://developer.apple.com/documentation/applemusicapi).
//
// Signing in happens in the browser through MusicKit on the Web, the only way Apple offers to obtain a
// Music User Token; the page hands that token to the server, which reads the library over plain HTTP with it
// plus a developer token signed here (ES256 JWT, built with node:crypto - no JWT library involved).
import { createPrivateKey, sign } from "node:crypto";
import type { ProviderSession, SourceAlbum, SourceArtist, SourceTrack, TransferProvider } from "../types";
import { chunk, num, str, transferFetch } from "../http";

const API = "https://api.music.apple.com";
const API_HOSTS = ["api.music.apple.com"];
const DEVELOPER_TOKEN_TTL_S = 12 * 60 * 60;

function config() {
    const c = useRuntimeConfig().transfer;
    return {
        teamId: c.appleMusicTeamId,
        keyId: c.appleMusicKeyId,
        // .env files can't hold a multi-line value everywhere, so "\n" escapes are accepted too
        privateKey: c.appleMusicPrivateKey.replace(/\\n/g, "\n")
    };
}

let cachedToken: { token: string, expiresAt: number } | null = null;

// the developer token is not a secret in the way the private key is: MusicKit needs it in the browser.
// It's short-lived and re-signed on demand.
export function getAppleDeveloperToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && cachedToken.expiresAt - 300 > now) return cachedToken.token;

    const { teamId, keyId, privateKey } = config();
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: teamId, iat: now, exp: now + DEVELOPER_TOKEN_TTL_S })}`;
    // JWS wants the raw r||s signature, not DER - hence ieee-p1363
    const signature = sign("sha256", Buffer.from(unsigned), { key: createPrivateKey(privateKey), dsaEncoding: "ieee-p1363" }).toString("base64url");

    cachedToken = { token: `${unsigned}.${signature}`, expiresAt: now + DEVELOPER_TOKEN_TTL_S };
    return cachedToken.token;
}

function get<T>(session: ProviderSession, path: string): Promise<T> {
    return transferFetch<T>(`${API}${path}`, API_HOSTS, {
        headers: {
            Authorization: `Bearer ${getAppleDeveloperToken()}`,
            "Music-User-Token": session.accessToken ?? ""
        }
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { id: string, type: string, attributes?: any };

// library endpoints page with a relative `next` path ("/v1/me/library/songs?offset=100")
async function collect(session: ProviderSession, firstPath: string, max: number): Promise<Resource[]> {
    const out: Resource[] = [];
    let path: string | undefined = firstPath;
    while (path && out.length < max) {
        const json: { data?: Resource[], next?: string } = await get(session, path);
        out.push(...(json.data ?? []));
        // only ever follow a relative API path - `next` is concatenated onto the fixed API origin
        path = typeof json.next === "string" && json.next.startsWith("/v1/") ? json.next : undefined;
    }
    return out.slice(0, max);
}

async function total(session: ProviderSession, path: string): Promise<number | null> {
    return get<{ meta?: { total?: number } }>(session, path).then((json) => num(json.meta?.total)).catch(() => null);
}

// library songs don't carry an ISRC themselves; their catalog counterparts do, fetched 300 at a time
async function withIsrcs(session: ProviderSession, resources: Resource[]): Promise<SourceTrack[]> {
    const tracks = resources.map((r) => ({
        catalogId: str(r.attributes?.playParams?.catalogId) ?? (r.type === "songs" ? r.id : null),
        track: {
            externalId: r.id,
            title: str(r.attributes?.name),
            artist: str(r.attributes?.artistName),
            album: str(r.attributes?.albumName),
            isrc: str(r.attributes?.isrc),
            durationMs: num(r.attributes?.durationInMillis),
            // music videos and uploaded files without a catalog match
            unsupported: r.type === "library-music-videos" || r.type === "music-videos"
        } as SourceTrack
    }));

    const storefront = session.data.storefront;
    const missing = [...new Set(tracks.filter((t) => !t.track.isrc && t.catalogId).map((t) => t.catalogId!))];
    const isrcs = new Map<string, string>();

    if (storefront) {
        for (const ids of chunk(missing, 300)) {
            const json = await get<{ data?: Resource[] }>(session, `/v1/catalog/${encodeURIComponent(storefront)}/songs?ids=${ids.map(encodeURIComponent).join(",")}`).catch(() => ({ data: [] }));
            for (const song of json.data ?? []) {
                const isrc = str(song.attributes?.isrc);
                if (isrc) isrcs.set(song.id, isrc);
            }
        }
    }

    return tracks.map(({ catalogId, track }) => ({ ...track, isrc: track.isrc ?? (catalogId ? isrcs.get(catalogId) ?? null : null) }));
}

export const appleProvider: TransferProvider = {
    id: "apple",
    capabilities: { likedTracks: true, albums: true, artists: true, playlists: true },

    authModes: () => ["musickit"],
    isConfigured() {
        const { teamId, keyId, privateKey } = config();
        return !!(teamId && keyId && privateKey);
    },

    async init(session) {
        const json = await get<{ data?: Resource[] }>(session, "/v1/me/storefront");
        session.data.storefront = json.data?.[0]?.id ?? "us";
    },

    async overview(session) {
        const [likedTracks, albums, artists, playlists] = await Promise.all([
            total(session, "/v1/me/library/songs?limit=1"),
            total(session, "/v1/me/library/albums?limit=1"),
            total(session, "/v1/me/library/artists?limit=1"),
            collect(session, "/v1/me/library/playlists?limit=100", 2000)
        ]);

        return {
            account: null,
            likedTracks,
            albums,
            artists,
            playlists: playlists.map((p) => ({
                id: p.id,
                title: str(p.attributes?.name) ?? "Untitled",
                trackCount: null,
                image: str(p.attributes?.artwork?.url)?.replace("{w}", "120").replace("{h}", "120") ?? null
            }))
        };
    },

    async likedTracks(session, max) {
        return await withIsrcs(session, await collect(session, "/v1/me/library/songs?limit=100", max));
    },

    async albums(session, max) {
        const resources = await collect(session, "/v1/me/library/albums?limit=100", max);
        const albums = resources.map((r) => ({
            catalogId: str(r.attributes?.playParams?.catalogId),
            album: { externalId: r.id, title: str(r.attributes?.name), artist: str(r.attributes?.artistName), upc: null } as SourceAlbum
        }));

        const storefront = session.data.storefront;
        const upcs = new Map<string, string>();
        const ids = [...new Set(albums.map((a) => a.catalogId).filter((id): id is string => !!id))];
        if (storefront) {
            for (const batch of chunk(ids, 100)) {
                const json = await get<{ data?: Resource[] }>(session, `/v1/catalog/${encodeURIComponent(storefront)}/albums?ids=${batch.map(encodeURIComponent).join(",")}`).catch(() => ({ data: [] }));
                for (const album of json.data ?? []) {
                    const upc = str(album.attributes?.upc);
                    if (upc) upcs.set(album.id, upc);
                }
            }
        }

        return albums.map(({ catalogId, album }) => ({ ...album, upc: catalogId ? upcs.get(catalogId) ?? null : null }));
    },

    async artists(session, max) {
        const resources = await collect(session, "/v1/me/library/artists?limit=100", max);
        return resources.map((r): SourceArtist => ({ externalId: r.id, name: str(r.attributes?.name) }));
    },

    async playlistTracks(session, playlistId, max) {
        return await withIsrcs(session, await collect(session, `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`, max));
    }
};
