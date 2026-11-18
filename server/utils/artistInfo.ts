// The artist metadata Nafyn can't get from MusicBrainz: a biography and a picture from TheAudioDB, and a listener
// count from ListenBrainz. Both are public; TheAudioDB works with its free key "123" (30 requests a minute), a
// paid key in THEAUDIODB_API_KEY lifts that limit. Answers are cached in memory, a failed lookup only briefly.
import { USER_AGENT } from "./app";
import { audioDbArtist, listenBrainzListeners, type AudioDbArtist } from "./artistImageParse";

export interface ArtistMetadata {
    bio: string | null,
    image: string | null,
    listeners: number | null
}

interface Lookup<T> {
    value: T,
    /** An upstream failed, so an empty value here is not an answer. */
    unsure: boolean
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// a failed lookup (TheAudioDB or ListenBrainz down, timed out) is remembered briefly, not for six hours: the artist
// page would otherwise stay bio-less long after the service recovered
const FAILURE_TTL_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
// the key is partly user-influenced (artist names from Subsonic clients), so the maps are capped; oldest-inserted goes first
const MAX_CACHE_ENTRIES = 2_000;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TimedCache<T> {
    private readonly entries = new Map<string, { value: T, expiresAtMs: number }>();
    private readonly inFlight = new Map<string, Promise<T>>();

    /** the cached value, or one run of `load` shared by everyone asking for the same key meanwhile */
    get(key: string, load: () => Promise<Lookup<T>>): Promise<T> {
        const hit = this.entries.get(key);
        if (hit && hit.expiresAtMs > Date.now()) return Promise.resolve(hit.value);
        let pending = this.inFlight.get(key);
        if (!pending) {
            pending = load()
                .then(({ value, unsure }) => {
                    if (this.entries.size >= MAX_CACHE_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
                    this.entries.set(key, { value, expiresAtMs: Date.now() + (unsure ? FAILURE_TTL_MS : CACHE_TTL_MS) });
                    return value;
                })
                .finally(() => this.inFlight.delete(key));
            this.inFlight.set(key, pending);
        }
        return pending;
    }
}

async function getJson(url: string, init: RequestInit = {}): Promise<{ ok: true, body: unknown } | { ok: false }> {
    try {
        const response = await fetch(url, {
            ...init,
            headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...init.headers },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            redirect: "error"
        });
        // TheAudioDB answers 429 past its rate limit: not an answer about the artist
        if (!response.ok) return { ok: false };
        return { ok: true, body: await response.json() };
    } catch {
        return { ok: false };
    }
}

// undefined: TheAudioDB couldn't be asked (down, timed out, rate limited)
const audioDbCache = new TimedCache<AudioDbArtist | null | undefined>();

/**
 * TheAudioDB's entry for an artist: by MusicBrainz ID when known (no name collisions), else by name. null when it
 * doesn't know the artist, undefined when it couldn't be asked.
 */
export function getAudioDbArtist(name: string, mbid?: string | null): Promise<AudioDbArtist | null | undefined> {
    const key = useRuntimeConfig().theaudiodbApiKey;
    if (!key) return Promise.resolve(null);
    const id = mbid && MBID_RE.test(mbid) ? mbid.toLowerCase() : null;
    if (!id && !name.trim()) return Promise.resolve(null);

    return audioDbCache.get(id ?? `name:${name.trim().toLowerCase()}`, async () => {
        const base = `https://www.theaudiodb.com/api/v1/json/${encodeURIComponent(key)}`;
        const answer = await getJson(id ? `${base}/artist-mb.php?i=${id}` : `${base}/search.php?s=${encodeURIComponent(name.trim())}`);
        return answer.ok ? { value: audioDbArtist(answer.body, id), unsure: false } : { value: undefined, unsure: true };
    }).catch(() => undefined);
}

const listenersCache = new TimedCache<number | null>();

/** How many people listened to the artist on ListenBrainz (needs the MusicBrainz ID). */
export function getArtistListeners(mbid: string | null | undefined): Promise<number | null> {
    if (!mbid || !MBID_RE.test(mbid)) return Promise.resolve(null);
    const id = mbid.toLowerCase();
    return listenersCache.get(id, async () => {
        const answer = await getJson("https://api.listenbrainz.org/1/popularity/artist", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ artist_mbids: [id] })
        });
        return answer.ok ? { value: listenBrainzListeners(answer.body, id), unsure: false } : { value: null, unsure: true };
    }).catch(() => null);
}

/** Bio and picture from TheAudioDB, listeners from ListenBrainz; each null when unknown. Never throws. */
export async function getArtistInfo(name: string, mbid?: string | null): Promise<ArtistMetadata> {
    const [audioDb, listeners] = await Promise.all([getAudioDbArtist(name, mbid), getArtistListeners(mbid)]);
    return { bio: audioDb?.bio ?? null, image: audioDb?.image ?? null, listeners };
}
