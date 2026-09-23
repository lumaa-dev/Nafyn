// TIDAL API v2 (https://developer.tidal.com/documentation/api-sdk/api-sdk-overview), JSON:API over
// https://openapi.tidal.com/v2, authorization code + PKCE (a client secret is optional for TIDAL).
//
// Collections and playlists only hand back resource identifiers; the actual track/album/artist attributes
// (title, ISRC, barcode...) are then fetched in batches through the filter[id] endpoints.
import type { ProviderSession, SourceAlbum, SourceArtist, SourceTrack, TransferProvider } from "../types";
import { chunk, isoDurationToMs, num, str, transferFetch, transferPostForm } from "../http";

const API = "https://openapi.tidal.com/v2";
const API_HOSTS = ["openapi.tidal.com"];
const AUTH_HOSTS = ["auth.tidal.com"];
const SCOPES = ["user.read", "collection.read", "playlists.read"];
const BATCH = 20;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resource = { id: string, type: string, attributes?: any, relationships?: any };

function config() {
    const c = useRuntimeConfig().transfer;
    return { clientId: c.tidalClientId, clientSecret: c.tidalClientSecret };
}

function get<T>(session: ProviderSession, url: string): Promise<T> {
    return transferFetch<T>(url, API_HOSTS, {
        headers: { Authorization: `Bearer ${session.accessToken}`, Accept: "application/vnd.api+json" }
    });
}

function country(session: ProviderSession): string {
    return encodeURIComponent(session.data.country || "US");
}

// pages through a relationship endpoint, returning only the {id, type} identifiers it lists
async function identifiers(session: ProviderSession, firstUrl: string, max: number): Promise<{ id: string, type: string }[]> {
    const out: { id: string, type: string }[] = [];
    let url: string | undefined = firstUrl;
    while (url && out.length < max) {
        const json: { data?: { id: string, type: string }[], links?: { next?: string } } = await get(session, url);
        out.push(...(json.data ?? []));
        const next = json.links?.next;
        // `next` is usually a path relative to the API root; resolved against it, and re-checked by transferFetch
        url = typeof next === "string" ? (next.startsWith("http") ? next : `${API}${next.startsWith("/") ? "" : "/"}${next}`) : undefined;
    }
    return out.slice(0, max);
}

// batch-fetches full resources (with `include`d relations) for a list of ids, preserving the input order
async function resources(session: ProviderSession, type: "tracks" | "albums" | "artists" | "playlists", ids: string[], include: string | null): Promise<{ byId: Map<string, Resource>, included: Map<string, Resource> }> {
    const byId = new Map<string, Resource>();
    const included = new Map<string, Resource>();
    for (const batch of chunk([...new Set(ids)], BATCH)) {
        const filter = batch.map((id) => `filter[id]=${encodeURIComponent(id)}`).join("&");
        const json = await get<{ data?: Resource[], included?: Resource[] }>(session, `${API}/${type}?countryCode=${country(session)}&${filter}${include ? `&include=${include}` : ""}`);
        for (const r of json.data ?? []) byId.set(r.id, r);
        for (const r of json.included ?? []) included.set(`${r.type}:${r.id}`, r);
    }
    return { byId, included };
}

function relatedName(resource: Resource | undefined, relation: string, included: Map<string, Resource>, field: string): string | null {
    const ref = resource?.relationships?.[relation]?.data?.[0];
    if (!ref) return null;
    return str(included.get(`${ref.type}:${ref.id}`)?.attributes?.[field]);
}

async function tracksFor(session: ProviderSession, refs: { id: string, type: string }[]): Promise<SourceTrack[]> {
    const trackIds = refs.filter((r) => r.type === "tracks").map((r) => r.id);
    const { byId, included } = await resources(session, "tracks", trackIds, "artists,albums");

    return refs.map((ref): SourceTrack => {
        if (ref.type !== "tracks") return { externalId: ref.id, title: null, artist: null, album: null, isrc: null, durationMs: null, unsupported: true };
        const t = byId.get(ref.id);
        const version = str(t?.attributes?.version);
        const title = str(t?.attributes?.title);
        return {
            externalId: ref.id,
            // TIDAL splits "Song (Remastered 2011)" into title + version; MusicBrainz keeps it in the title
            title: title && version ? `${title} (${version})` : title,
            artist: relatedName(t, "artists", included, "name"),
            album: relatedName(t, "albums", included, "title"),
            isrc: str(t?.attributes?.isrc),
            durationMs: isoDurationToMs(t?.attributes?.duration)
        };
    });
}

function collection(session: ProviderSession, relation: string): string {
    return `${API}/userCollections/${encodeURIComponent(session.data.userId ?? "")}/relationships/${relation}?countryCode=${country(session)}&locale=en-US`;
}

export const tidalProvider: TransferProvider = {
    id: "tidal",
    capabilities: { likedTracks: true, albums: true, artists: true, playlists: true },
    usesPkce: true,

    authModes: () => ["oauth"],
    isConfigured: () => !!config().clientId,

    authorizeUrl({ state, redirectUri, codeChallenge }) {
        const params = new URLSearchParams({
            response_type: "code",
            client_id: config().clientId,
            redirect_uri: redirectUri,
            scope: SCOPES.join(" "),
            code_challenge_method: "S256",
            code_challenge: codeChallenge,
            state
        });
        return `https://login.tidal.com/authorize?${params}`;
    },

    async exchangeCode({ code, redirectUri, codeVerifier }) {
        const { clientId, clientSecret } = config();
        const form: Record<string, string> = {
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier
        };
        if (clientSecret) form.client_secret = clientSecret;
        const json = await transferPostForm<{ access_token: string, expires_in?: number }>("https://auth.tidal.com/v1/oauth2/token", AUTH_HOSTS, form);
        return { accessToken: json.access_token, expiresIn: json.expires_in ?? null };
    },

    async init(session) {
        const json = await get<{ data?: Resource }>(session, `${API}/users/me`);
        session.data.userId = json.data?.id ?? "";
        session.data.country = str(json.data?.attributes?.country) ?? "US";
        session.data.account = str(json.data?.attributes?.username) ?? "";
        if (!session.data.userId) throw new Error("TIDAL did not return a user id");
    },

    async overview(session) {
        const collected = await identifiers(session, collection(session, "playlists"), 2000).catch(() => []);
        // playlists the user created themselves aren't necessarily in their collection
        const owned = await get<{ data?: Resource[] }>(session, `${API}/playlists?countryCode=${country(session)}&filter[r.owners.id]=${encodeURIComponent(session.data.userId ?? "")}`)
            .then((json) => json.data ?? [])
            .catch(() => [] as Resource[]);

        const ids = [...new Set([...owned.map((p) => p.id), ...collected.map((p) => p.id)])];
        const { byId } = await resources(session, "playlists", ids.filter((id) => !owned.some((p) => p.id === id)), null).catch(() => ({ byId: new Map<string, Resource>() }));
        for (const p of owned) byId.set(p.id, p);

        return {
            account: session.data.account || null,
            // collections are cursor-paged with no total; counting them would mean reading them in full
            likedTracks: null,
            albums: null,
            artists: null,
            playlists: ids.map((id) => {
                const p = byId.get(id);
                return { id, title: str(p?.attributes?.name) ?? "Untitled", trackCount: num(p?.attributes?.numberOfItems), image: null };
            })
        };
    },

    async likedTracks(session, max) {
        return await tracksFor(session, await identifiers(session, collection(session, "tracks"), max));
    },

    async albums(session, max) {
        const refs = await identifiers(session, collection(session, "albums"), max);
        const { byId, included } = await resources(session, "albums", refs.map((r) => r.id), "artists");
        return refs.map((ref): SourceAlbum => {
            const a = byId.get(ref.id);
            return { externalId: ref.id, title: str(a?.attributes?.title), artist: relatedName(a, "artists", included, "name"), upc: str(a?.attributes?.barcodeId) };
        });
    },

    async artists(session, max) {
        const refs = await identifiers(session, collection(session, "artists"), max);
        const { byId } = await resources(session, "artists", refs.map((r) => r.id), null);
        return refs.map((ref): SourceArtist => ({ externalId: ref.id, name: str(byId.get(ref.id)?.attributes?.name) }));
    },

    async playlistTracks(session, playlistId, max) {
        const refs = await identifiers(session, `${API}/playlists/${encodeURIComponent(playlistId)}/relationships/items?countryCode=${country(session)}`, max);
        return await tracksFor(session, refs);
    }
};
