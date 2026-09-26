// Discogs API (https://www.discogs.com/developers) - needs a personal access token (DISCOGS_TOKEN, free under
// Settings -> Developers on discogs.com); skipped when it's unset. 60 authenticated requests a minute,
// reported back in `X-Discogs-Ratelimit-Remaining`. Discogs catalogues releases, not recordings, so its
// records are albums - their value here is genres/styles, labels, credits and tracklists.
import { providerFetchJson } from "../http";
import type { MetadataProvider, SongMetadata, TextQuery } from "../types";

const API = "https://api.discogs.com";

interface DiscogsSearchResult {
    id: number,
    type: string,
    title: string,
    year?: string,
    genre?: string[],
    style?: string[],
    label?: string[],
    country?: string,
    format?: string[],
    barcode?: string[],
    cover_image?: string,
    thumb?: string,
    uri?: string,
    master_id?: number
}

interface DiscogsRelease {
    id: number,
    title: string,
    artists?: { name: string }[],
    year?: number,
    released?: string,
    genres?: string[],
    styles?: string[],
    country?: string,
    images?: { type: string, uri: string }[],
    labels?: { name: string, catno?: string }[],
    tracklist?: { position: string, title: string, duration: string }[],
    extraartists?: { name: string, role: string }[],
    identifiers?: { type: string, value: string }[],
    uri?: string,
    notes?: string
}

function token(): string {
    return useRuntimeConfig().discogsToken;
}

function get<T>(path: string): Promise<T | null> {
    return providerFetchJson<T>("discogs", `${API}${path}`, { headers: { Authorization: `Discogs token=${token()}` } });
}

// Discogs disambiguates same-named artists with a ` (2)` suffix
function cleanArtist(name: string): string {
    return name.replace(/\s\(\d+\)$/, "");
}

function searchToMetadata(result: DiscogsSearchResult): SongMetadata {
    // search results title releases as `Artist - Release`
    const dash = result.title.indexOf(" - ");
    const artist = dash > 0 ? cleanArtist(result.title.slice(0, dash)) : null;
    const title = dash > 0 ? result.title.slice(dash + 3) : result.title;

    return {
        provider: "discogs",
        ref: `discogs:release:${result.id}`,
        kind: "album",
        title,
        artists: artist ? [artist] : [],
        album: title,
        duration: null,
        isrc: null,
        releaseDate: result.year || null,
        genres: result.genre ?? [],
        artwork: [result.cover_image, result.thumb].filter((u): u is string => !!u),
        previews: [],
        url: result.uri ? `https://www.discogs.com${result.uri}` : null,
        musicbrainzId: null,
        extra: {
            discogsId: result.id,
            masterId: result.master_id || null,
            styles: result.style ?? [],
            labels: result.label ?? [],
            formats: result.format ?? [],
            country: result.country ?? null,
            barcodes: result.barcode ?? []
        }
    };
}

function releaseToMetadata(release: DiscogsRelease, kind: string): SongMetadata {
    const images = [...(release.images ?? [])].sort((a, b) => (a.type === "primary" ? -1 : 0) - (b.type === "primary" ? -1 : 0));

    return {
        provider: "discogs",
        ref: `discogs:${kind}:${release.id}`,
        kind: "album",
        title: release.title,
        artists: release.artists?.map((a) => cleanArtist(a.name)) ?? [],
        album: release.title,
        duration: null,
        isrc: null,
        releaseDate: release.released || (release.year ? String(release.year) : null),
        genres: release.genres ?? [],
        artwork: images.map((i) => i.uri),
        previews: [],
        url: release.uri ?? null,
        musicbrainzId: null,
        extra: {
            discogsId: release.id,
            styles: release.styles ?? [],
            country: release.country ?? null,
            labels: release.labels?.map((l) => ({ name: l.name, catalogNumber: l.catno ?? null })) ?? [],
            tracklist: release.tracklist?.map((t) => ({ position: t.position, title: t.title, duration: t.duration || null })) ?? [],
            credits: release.extraartists?.map((a) => ({ name: cleanArtist(a.name), role: a.role })) ?? [],
            identifiers: release.identifiers ?? [],
            notes: release.notes ?? null
        }
    };
}

export const discogsProvider: MetadataProvider = {
    id: "discogs",
    name: "Discogs",
    enabled: () => !!token(),

    async search(query: TextQuery, limit: number) {
        const params = new URLSearchParams({ type: "release", per_page: String(limit) });
        if (query.title && query.artist) {
            params.set("artist", query.artist);
            params.set("track", query.title);
        } else {
            params.set("q", query.text);
        }
        const res = await get<{ results?: DiscogsSearchResult[] }>(`/database/search?${params.toString()}`);
        return res?.results?.map(searchToMetadata) ?? [];
    },

    async byId(kind: string, id: string) {
        if (!/^\d+$/.test(id)) return null;
        const resource = kind === "master" ? "masters" : "releases";
        const release = await get<DiscogsRelease>(`/${resource}/${id}`);
        return release?.id ? releaseToMetadata(release, kind === "master" ? "master" : "release") : null;
    }
};
