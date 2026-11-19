// TheAudioDB's genre / style / mood of the artists and albums the recommender looks at (utils/audioDbTags.ts says
// how they are used). Fetched in the background only (a mixes refresh), never while someone waits:
//   - answers are kept in `rec_external_cache` (`adb:artist:<mbid>`, `adb:album:<release-group mbid>`), 30 days, an
//     "it doesn't know" answer 7 days, so a library is only ever asked about once a month;
//   - each call spends at most `budget` network lookups, the rest is left for the next refresh;
//   - lookups leave at least 2.1 s apart, process-wide: the free key allows 30 requests a minute, and the artist
//     page shares it.
import { getLibrariesDb } from "./db";
import { getAudioDbAlbum, getAudioDbArtist } from "../utils/artistInfo";
import { type AudioDbTags, mergeTags } from "../utils/audioDbTags";

const DAY = 24 * 60 * 60 * 1000;
const KNOWN_TTL_MS = 30 * DAY;
const UNKNOWN_TTL_MS = 7 * DAY;
const LOOKUP_SPACING_MS = 2100;
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let nextLookupAt = 0;

/** Waits for this process' next TheAudioDB slot, then runs `fn` in it. */
async function spaced<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const at = Math.max(now, nextLookupAt);
    nextLookupAt = at + LOOKUP_SPACING_MS;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
    return fn();
}

export interface AudioDbTagSets {
    artists: Map<string, AudioDbTags>,
    albums: Map<string, AudioDbTags>
}

type Kind = "artist" | "album";

/**
 * The tags of these artists and albums (MusicBrainz IDs; anything else is ignored): from the cache, then from
 * TheAudioDB for at most `budget` of the missing or stale ones, albums first (an album's tags are the more
 * precise). Never throws: what could not be asked is simply not in the maps.
 */
export async function audioDbTags(refs: readonly { artistMbid?: string | null, albumId?: string | null }[], budget: number): Promise<AudioDbTagSets> {
    const wanted: Record<Kind, Set<string>> = { artist: new Set(), album: new Set() };
    for (const ref of refs) {
        if (ref.artistMbid && MBID_RE.test(ref.artistMbid)) wanted.artist.add(ref.artistMbid.toLowerCase());
        if (ref.albumId && MBID_RE.test(ref.albumId)) wanted.album.add(ref.albumId.toLowerCase());
    }
    const result: AudioDbTagSets = { artists: new Map(), albums: new Map() };
    const store = (kind: Kind) => kind === "artist" ? result.artists : result.albums;
    const keys = [...[...wanted.album].map((id) => `adb:album:${id}`), ...[...wanted.artist].map((id) => `adb:artist:${id}`)];
    if (keys.length === 0) return result;

    const db = getLibrariesDb();
    const fresh = new Set<string>();
    try {
        for (let i = 0; i < keys.length; i += 500) {
            const chunk = keys.slice(i, i + 500);
            const rows = await db.prepare(`
                SELECT cache_key, payload, fetched_at FROM rec_external_cache WHERE cache_key IN (${chunk.map(() => "?").join(", ")})
            `).all<{ cache_key: string, payload: string, fetched_at: number | string }>(...chunk);
            for (const row of rows) {
                const [, kind, id] = row.cache_key.split(":") as [string, Kind, string];
                const tags = JSON.parse(row.payload) as AudioDbTags | null;
                if (tags) store(kind).set(id, tags);
                if (Date.now() - Number(row.fetched_at) < (tags ? KNOWN_TTL_MS : UNKNOWN_TTL_MS)) fresh.add(row.cache_key);
            }
        }
    } catch (error) {
        console.error("[recommendations] could not read the TheAudioDB cache:", error);
        return result;
    }

    let lookups = 0;
    for (const key of keys) {
        if (fresh.has(key) || lookups >= budget) continue;
        lookups++;
        const [, kind, id] = key.split(":") as [string, Kind, string];
        const answer = await spaced(() => kind === "album"
            ? getAudioDbAlbum(id)
            : getAudioDbArtist("", id).then((artist) => artist === undefined ? undefined : artist?.tags ?? null));
        // undefined: TheAudioDB couldn't be asked - keep the stale answer if there is one, ask again next time
        if (answer === undefined) continue;
        if (answer) store(kind).set(id, answer);
        else store(kind).delete(id);
        await db.prepare(`
            INSERT INTO rec_external_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = VALUES(fetched_at)
        `).run(key, JSON.stringify(answer), Date.now()).catch((error: unknown) => {
            console.error("[recommendations] could not store a TheAudioDB answer:", error);
        });
    }
    return result;
}

/** One track's tags: its album's, completed by its artist's. */
export function trackTags(sets: AudioDbTagSets, artistMbid: string | null | undefined, albumId: string | null | undefined): AudioDbTags {
    return mergeTags(albumId ? sets.albums.get(albumId.toLowerCase()) : null, artistMbid ? sets.artists.get(artistMbid.toLowerCase()) : null);
}
