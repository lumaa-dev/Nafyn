// thin client for Last.fm's artist.getInfo (https://www.last.fm/api/show/artist.getInfo) - the only piece
// of artist metadata Nafyn can't get from MusicBrainz: a bio and (nominally) an image. Last.fm stopped
// returning real per-artist photos years ago (licensing) - the `image` field below is usually a Last.fm
// placeholder or null in practice, kept anyway since Last.fm can still start returning real ones and callers
// already treat it as "may be null".
import { lastfmProfileUrl, ogImage, usableImageUrl } from "./artistImageParse";

const LASTFM_URL = "https://ws.audioscrobbler.com/2.0/";

export interface LastfmArtistInfo {
    bio: string | null,
    image: string | null,
    listeners: number | null,
    /** The artist's Last.fm profile page, when the API said which it is. */
    url: string | null
}

interface LastfmImage {
    "#text": string,
    size: string
}

interface LastfmArtistResponse {
    artist?: {
        url?: string,
        bio?: { summary?: string },
        image?: LastfmImage[],
        stats?: { listeners?: string }
    },
    error?: number,
    message?: string
}

const cache = new Map<string, { value: LastfmArtistInfo | null, expiresAtMs: number }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// a failed lookup (Last.fm down, timed out) is remembered briefly, not for six hours: the artist page would
// otherwise stay bio-less long after Last.fm recovered
const FAILURE_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
// the key is partly user-influenced (artist names from search), so the map is capped; oldest-inserted goes first
const MAX_CACHE_ENTRIES = 2_000;

// strips the "<a href="...">Read more on Last.fm</a>" (and similar) trailer Last.fm appends to every bio
function cleanBio(summary: string | undefined): string | null {
    if (!summary) return null;
    const cleaned = summary.replace(/<a\s+href="[^"]*">[^<]*<\/a>\.?\s*$/i, "").trim();
    return cleaned || null;
}

function bestImage(images: LastfmImage[] | undefined): string | null {
    if (!images || images.length === 0) return null;
    // Last.fm orders small -> extralarge -> mega; last one present is the biggest
    const sized = images.filter((img) => img["#text"]);
    return sized.length > 0 ? usableImageUrl(sized[sized.length - 1]!["#text"]) : null;
}

// looks up an artist by MusicBrainz ID when known (more precise - avoids name collisions), else by name
export async function getLastfmArtistInfo(name: string, mbid?: string | null): Promise<LastfmArtistInfo | null> {
    const config = useRuntimeConfig();
    if (!config.lastfmApiKey) return null;

    const cacheKey = mbid || name.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;

    const params = new URLSearchParams({
        method: "artist.getinfo",
        api_key: config.lastfmApiKey,
        format: "json",
        autocorrect: "1"
    });
    if (mbid) params.set("mbid", mbid);
    else params.set("artist", name);

    let value: LastfmArtistInfo | null = null;
    let failed = false;
    try {
        const res = await fetch(`${LASTFM_URL}?${params.toString()}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!res.ok) failed = true;
        if (res.ok) {
            const data = await res.json() as LastfmArtistResponse;
            if (data.artist && !data.error) {
                value = {
                    bio: cleanBio(data.artist.bio?.summary),
                    image: bestImage(data.artist.image),
                    listeners: data.artist.stats?.listeners ? Number(data.artist.stats.listeners) : null,
                    url: lastfmProfileUrl(data.artist.url)
                };
            }
        }
    } catch {
        value = null;
        failed = true;
    }

    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { value, expiresAtMs: Date.now() + (failed ? FAILURE_TTL_MS : CACHE_TTL_MS) });
    return value;
}

// The API's `image` is the star placeholder for nearly every artist, but the artist's profile page shows (and
// advertises, as its og:image) a real photo. The page is fetched by hand: only last.fm itself may be asked, also
// after a redirect (/music/radiohead -> /music/Radiohead), and only the start of the document is read.
const PROFILE_TIMEOUT_MS = 6_000;
const PROFILE_MAX_REDIRECTS = 3;
const PROFILE_MAX_BYTES = 400_000;

const profileImages = new Map<string, { value: string | null, expiresAtMs: number }>();

async function readHead(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    try {
        while (bytes < PROFILE_MAX_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            html += decoder.decode(value, { stream: true });
            // the meta tags are in <head>
            if (html.includes("</head>")) break;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    return html;
}

/** The photo on an artist's Last.fm profile (`https://www.last.fm/music/<name>`), or null when it has none. */
export async function getLastfmProfileImage(profileUrl: string): Promise<string | null> {
    const canonical = lastfmProfileUrl(profileUrl);
    if (!canonical) return null;

    const cached = profileImages.get(canonical);
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;

    let value: string | null = null;
    let failed = false;
    try {
        const signal = AbortSignal.timeout(PROFILE_TIMEOUT_MS);
        let target = canonical;
        for (let hop = 0; hop <= PROFILE_MAX_REDIRECTS; hop++) {
            // SECURITY: re-checked on every hop, a redirect must not lead the server anywhere else
            if (!lastfmProfileUrl(target)) { failed = true; break; }
            const response = await fetch(target, { redirect: "manual", signal, headers: { "User-Agent": "Nafyn (self-hosted music app)", "Accept": "text/html" } });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get("location");
                if (!location) { failed = true; break; }
                target = new URL(location, target).href;
                continue;
            }
            if (response.ok) value = ogImage(await readHead(response));
            else failed = response.status !== 404;
            break;
        }
    } catch {
        failed = true;
    }

    if (profileImages.size >= MAX_CACHE_ENTRIES) profileImages.delete(profileImages.keys().next().value!);
    profileImages.set(canonical, { value, expiresAtMs: Date.now() + (failed ? FAILURE_TTL_MS : CACHE_TTL_MS) });
    return value;
}
