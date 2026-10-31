// Pure helpers behind the artist image lookup (server/utils/artistImage.ts): no Nitro auto-imports, so they run
// under `bun test`.

// MusicBrainz url-rels of an artist: `{ type: "last.fm", url: { resource: "https://www.last.fm/music/Radiohead" } }`
export interface UrlRelation {
    type?: string,
    url?: { resource?: string } | null
}

// "https://www.last.fm/music/Name" (also `last.fm`, an `/en/` style locale prefix, a trailing slash or `/+images`)
// -> the canonical profile URL, or null for anything that isn't a Last.fm artist profile. The URL comes from
// user-edited MusicBrainz data and is then fetched server-side, so the host is pinned and the URL rebuilt from
// the artist segment alone.
const LASTFM_ARTIST_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?music\/([^/?#]+)/i;

export function lastfmProfileUrl(resource: string | null | undefined): string | null {
    if (!resource) return null;
    let url: URL;
    try {
        url = new URL(resource);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "last.fm" && host !== "www.last.fm") return null;

    const segment = LASTFM_ARTIST_PATH.exec(url.pathname)?.[1];
    // "+tag"-style segments are not artists; a bare "+" leads nowhere either
    if (!segment || segment.startsWith("+")) return null;
    return `https://www.last.fm/music/${segment}`;
}

export function lastfmProfileFromRelations(relations: UrlRelation[] | null | undefined): string | null {
    for (const relation of relations ?? []) {
        if (relation.type?.toLowerCase() !== "last.fm") continue;
        const url = lastfmProfileUrl(relation.url?.resource);
        if (url) return url;
    }
    return null;
}

// the star image Last.fm shows for an artist without a photo; not a picture of anybody
const LASTFM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";

// an https image URL that is a real picture, or null
export function usableImageUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:") return null;
    if (url.href.includes(LASTFM_PLACEHOLDER)) return null;
    return url.href;
}

function decodeEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"")
        .replace(/&#0*39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

// the `og:image` of an HTML page, whatever the attribute order
export function ogImage(html: string): string | null {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        if (!/\b(?:property|name)\s*=\s*["']og:image["']/i.test(tag)) continue;
        const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        const value = content?.[1] ?? content?.[2];
        if (value) return usableImageUrl(decodeEntities(value));
    }
    return null;
}

// TheAudioDB `artist-mb.php` answer -> the artist's thumbnail. `artists` is null when it doesn't know the artist.
export function audioDbThumb(body: unknown, mbid: string): string | null {
    const artists = (body as { artists?: Array<Record<string, unknown>> | null } | null)?.artists;
    if (!Array.isArray(artists)) return null;
    for (const artist of artists) {
        const theirs = typeof artist.strMusicBrainzID === "string" ? artist.strMusicBrainzID.toLowerCase() : null;
        if (theirs && theirs !== mbid.toLowerCase()) continue;
        const image = usableImageUrl(typeof artist.strArtistThumb === "string" ? artist.strArtistThumb : null);
        if (image) return image;
    }
    return null;
}
