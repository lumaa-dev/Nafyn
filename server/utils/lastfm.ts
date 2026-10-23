// thin client for Last.fm's artist.getInfo (https://www.last.fm/api/show/artist.getInfo) - the only piece
// of artist metadata Nafyn can't get from MusicBrainz: a bio and (nominally) an image. Last.fm stopped
// returning real per-artist photos years ago (licensing) - the `image` field below is usually a Last.fm
// placeholder or null in practice, kept anyway since Last.fm can still start returning real ones and callers
// already treat it as "may be null".
const LASTFM_URL = "https://ws.audioscrobbler.com/2.0/";

export interface LastfmArtistInfo {
    bio: string | null,
    image: string | null,
    listeners: number | null
}

interface LastfmImage {
    "#text": string,
    size: string
}

interface LastfmArtistResponse {
    artist?: {
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
    return sized.length > 0 ? sized[sized.length - 1]!["#text"] : null;
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
                    listeners: data.artist.stats?.listeners ? Number(data.artist.stats.listeners) : null
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
