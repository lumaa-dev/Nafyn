// Pure helpers behind the artist info and picture lookups (server/utils/artistInfo.ts, server/utils/artistImage.ts):
// no Nitro auto-imports, so they run under `bun test`.

// MusicBrainz url-rels of an artist: `{ type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q44190" } }`
export interface UrlRelation {
    type?: string,
    url?: { resource?: string } | null
}

// an https image URL, or null
export function usableImageUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:") return null;
    return url.href;
}

export interface AudioDbArtist {
    image: string | null,
    bio: string | null
}

function text(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

// A TheAudioDB `artist-mb.php` / `search.php` answer -> the artist's thumbnail and English biography. `artists` is
// null when it doesn't know the artist. With an `mbid`, an artist TheAudioDB maps to another MusicBrainz ID is
// skipped; without one (a name search), the first artist is taken.
export function audioDbArtist(body: unknown, mbid: string | null): AudioDbArtist | null {
    const artists = (body as { artists?: Array<Record<string, unknown>> | null } | null)?.artists;
    if (!Array.isArray(artists)) return null;
    for (const artist of artists) {
        if (!artist || typeof artist !== "object") continue;
        const theirs = typeof artist.strMusicBrainzID === "string" ? artist.strMusicBrainzID.toLowerCase() : null;
        if (mbid && theirs && theirs !== mbid.toLowerCase()) continue;
        return {
            image: usableImageUrl(text(artist.strArtistThumb)),
            // the English one is `strBiographyEN` in older answers, plain `strBiography` in newer ones
            bio: text(artist.strBiographyEN) ?? text(artist.strBiography)
        };
    }
    return null;
}

const WIKIDATA_ENTITY = /^\/(?:wiki|entity)\/(Q[1-9]\d*)$/;

// "https://www.wikidata.org/wiki/Q44190" -> "Q44190", or null for anything that isn't a Wikidata item. The URL
// comes from user-edited MusicBrainz data, so only the item ID is kept: the host the server then asks is fixed.
export function wikidataId(resource: string | null | undefined): string | null {
    if (!resource) return null;
    let url: URL;
    try {
        url = new URL(resource);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname.toLowerCase() !== "www.wikidata.org" && url.hostname.toLowerCase() !== "wikidata.org") return null;
    return WIKIDATA_ENTITY.exec(url.pathname)?.[1] ?? null;
}

export function wikidataIdFromRelations(relations: UrlRelation[] | null | undefined): string | null {
    for (const relation of relations ?? []) {
        if (relation.type?.toLowerCase() !== "wikidata") continue;
        const id = wikidataId(relation.url?.resource);
        if (id) return id;
    }
    return null;
}

// A `wbgetclaims` answer for P18 (image) -> the Commons file name of the first one, or null
export function wikidataImageFile(body: unknown): string | null {
    const claims = (body as { claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: unknown } } }> } } | null)?.claims?.P18;
    if (!Array.isArray(claims)) return null;
    for (const claim of claims) {
        const file = text(claim?.mainsnak?.datavalue?.value);
        // a file name, never a path or a URL
        if (file && !file.includes("/")) return file;
    }
    return null;
}

/** a Commons file, scaled by Wikimedia to `width` pixels (Special:FilePath redirects to the thumbnail) */
export function commonsImageUrl(file: string, width = 1000): string {
    return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, "_"))}?width=${width}`;
}

// A ListenBrainz `popularity/artist` answer -> how many listeners the artist has, or null when it has no data
export function listenBrainzListeners(body: unknown, mbid: string): number | null {
    if (!Array.isArray(body)) return null;
    for (const entry of body as Array<Record<string, unknown> | null>) {
        if (typeof entry?.artist_mbid !== "string" || entry.artist_mbid.toLowerCase() !== mbid.toLowerCase()) continue;
        const count = entry.total_user_count;
        return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : null;
    }
    return null;
}
