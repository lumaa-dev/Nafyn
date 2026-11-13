// A Discogs collection as a list of albums to import (POST /api/v1/import/discogs). Pure parsing in
// `collectionToAlbums` (tests/discogs.test.ts); `fetchDiscogsCollection` reads the public collection API.
//
// Discogs' collection listing carries the title, the artists and the formats of each release, not its barcode (that
// is one more call per release, against a 25-per-minute limit): albums are matched on title + artist.

export interface DiscogsArtist {
    name?: string,
    anv?: string,
    join?: string
}

export interface DiscogsCollectionRelease {
    id?: number,
    basic_information?: {
        id?: number,
        title?: string,
        year?: number,
        artists?: DiscogsArtist[]
    }
}

export interface CollectionAlbum {
    title: string,
    artist: string
}

export const DISCOGS_USERNAME = /^[A-Za-z0-9_.-]{1,64}$/;
const API = "https://api.discogs.com";
const PER_PAGE = 100;
// Discogs allows 25 unauthenticated requests a minute
const PAGE_INTERVAL_MS = 2_500;

/** "Artist (2)" -> "Artist" (Discogs' numbering of same-named artists), "Artist*" -> "Artist" (its name-variation mark) */
export function cleanDiscogsArtist(name: string): string {
    const cleaned = name.replace(/\s+\(\d+\)$/, "").replace(/\*$/, "").trim();
    // Discogs' compilations are by "Various", MusicBrainz' by "Various Artists"
    return /^various$/i.test(cleaned) ? "Various Artists" : cleaned;
}

function creditText(artists: DiscogsArtist[] | undefined): string {
    const list = artists ?? [];
    return list.map((artist, i) => {
        const name = cleanDiscogsArtist(artist.name ?? "");
        const join = i < list.length - 1 ? (artist.join?.trim() ? ` ${artist.join.trim()} ` : ", ") : "";
        return name + join;
    }).join("").replace(/\s+/g, " ").trim();
}

/** one album per distinct title + artist (several pressings of the same album are one request) */
export function collectionToAlbums(releases: DiscogsCollectionRelease[], max: number): CollectionAlbum[] {
    const seen = new Set<string>();
    const out: CollectionAlbum[] = [];
    for (const release of releases) {
        const info = release.basic_information;
        const title = info?.title?.trim();
        const artist = creditText(info?.artists);
        if (!title || !artist) continue;
        const key = `${artist.toLowerCase()}\u0000${title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ title, artist });
        if (out.length >= max) break;
    }
    return out;
}

export class DiscogsError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = "DiscogsError";
    }
}

/** every release in the user's public collection ("All" folder), up to `maxReleases` */
export async function fetchDiscogsCollection(username: string, maxReleases: number, userAgent: string): Promise<DiscogsCollectionRelease[]> {
    if (!DISCOGS_USERNAME.test(username)) throw new DiscogsError(400, "Not a Discogs username");
    const releases: DiscogsCollectionRelease[] = [];
    for (let page = 1; releases.length < maxReleases; page++) {
        if (page > 1) await new Promise((resolve) => setTimeout(resolve, PAGE_INTERVAL_MS));
        const url = `${API}/users/${encodeURIComponent(username)}/collection/folders/0/releases?per_page=${PER_PAGE}&page=${page}&sort=added&sort_order=desc`;
        const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (!response) throw new DiscogsError(502, "Discogs could not be reached");
        if (response.status === 404) throw new DiscogsError(404, "No Discogs user by that name");
        if (response.status === 401 || response.status === 403) throw new DiscogsError(403, "This Discogs collection is private");
        if (response.status === 429) throw new DiscogsError(429, "Discogs is rate limiting, try again in a minute");
        if (!response.ok) throw new DiscogsError(502, `Discogs answered ${response.status}`);
        const json = await response.json().catch(() => null) as { releases?: DiscogsCollectionRelease[], pagination?: { pages?: number } } | null;
        releases.push(...(json?.releases ?? []));
        if (!json?.pagination?.pages || page >= json.pagination.pages) break;
    }
    return releases.slice(0, maxReleases);
}
