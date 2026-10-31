// Where an artist's picture comes from.
//
//   1. MusicBrainz lists the artist's Last.fm profile -> that profile's photo (it is the profile the community
//      attached to this very artist, so there is nothing to guess)
//   2. it doesn't -> TheAudioDB first, found through the MusicBrainz ID, then Last.fm by that ID / the name
//
// Step 1 falls back to the Last.fm API when the profile page yields nothing. Answers are cached (a picture does
// not change by the hour, and a search lists dozens of artists), concurrent lookups of one artist share a
// single run, and "no picture anywhere" is remembered for a shorter while than a hit.
import { getMusicBrainzRepository } from "~~/server/utils/musicbrainz";
import { getLastfmArtistInfo, getLastfmProfileImage } from "~~/server/utils/lastfm";
import { audioDbThumb, lastfmProfileFromRelations, type UrlRelation } from "~~/server/utils/artistImageParse";

const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
// an upstream that was down says nothing about the artist: ask again soon
const UNSURE_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 5_000;
const AUDIODB_TIMEOUT_MS = 5_000;

const cache = new Map<string, { image: string | null, expiresAtMs: number }>();
const inFlight = new Map<string, Promise<string | null>>();

/** The picture if it is already known (null = known to have none, undefined = never looked up); never a network call. */
export function peekArtistImage(mbid: string): string | null | undefined {
    const hit = cache.get(mbid.toLowerCase());
    return hit && hit.expiresAtMs > Date.now() ? hit.image : undefined;
}

interface Lookup {
    image: string | null,
    /** An upstream failed, so a null here is not an answer. */
    unsure: boolean
}

async function fromAudioDb(mbid: string): Promise<Lookup> {
    const key = useRuntimeConfig().theaudiodbApiKey;
    if (!key) return { image: null, unsure: false };
    try {
        const response = await fetch(`https://www.theaudiodb.com/api/v1/json/${encodeURIComponent(key)}/artist-mb.php?i=${encodeURIComponent(mbid)}`, {
            signal: AbortSignal.timeout(AUDIODB_TIMEOUT_MS),
            headers: { Accept: "application/json" }
        });
        if (!response.ok) return { image: null, unsure: true };
        return { image: audioDbThumb(await response.json(), mbid), unsure: false };
    } catch {
        return { image: null, unsure: true };
    }
}

async function run(mbid: string, name: string, relations: UrlRelation[] | null | undefined): Promise<Lookup> {
    let unsure = false;

    // MusicBrainz' own list of links wins
    let rels = relations;
    if (!rels) {
        try {
            rels = ((await getMusicBrainzRepository().lookup("artist", mbid, ["url-rels"])) as { relations?: UrlRelation[] }).relations ?? [];
        } catch {
            rels = [];
            unsure = true;
        }
    }
    const profile = lastfmProfileFromRelations(rels);
    if (profile) {
        const photo = await getLastfmProfileImage(profile);
        if (photo) return { image: photo, unsure: false };
        // the page had no usable photo (or was unreachable): the API may still know one for this artist
        const info = await getLastfmArtistInfo(name, mbid);
        return { image: info?.image ?? null, unsure };
    }

    // no Last.fm link: TheAudioDB first...
    const audioDb = await fromAudioDb(mbid);
    if (audioDb.image) return { image: audioDb.image, unsure: false };
    unsure ||= audioDb.unsure;

    // ...then Last.fm itself
    const info = await getLastfmArtistInfo(name, mbid);
    if (info?.url) {
        const photo = await getLastfmProfileImage(info.url);
        if (photo) return { image: photo, unsure: false };
    }
    return { image: info?.image ?? null, unsure };
}

/**
 * The artist's picture, or null. `relations` are the artist's MusicBrainz url-rels when the caller has them
 * already (the artist page does), which saves a lookup.
 */
export function resolveArtistImage(mbid: string, name: string, relations?: UrlRelation[] | null): Promise<string | null> {
    const key = mbid.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expiresAtMs > Date.now()) return Promise.resolve(hit.image);

    let pending = inFlight.get(key);
    if (!pending) {
        pending = run(key, name, relations)
            .then(({ image, unsure }) => {
                if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
                cache.set(key, { image, expiresAtMs: Date.now() + (image ? HIT_TTL_MS : unsure ? UNSURE_TTL_MS : MISS_TTL_MS) });
                return image;
            })
            .catch(() => null)
            .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
    }
    return pending;
}
