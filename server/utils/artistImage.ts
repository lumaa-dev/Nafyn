// Where an artist's picture comes from.
//
//   1. TheAudioDB, found through the MusicBrainz ID (the same answer that carries the artist's bio, so the artist
//      page asks once)
//   2. it has none -> the image of the Wikidata item MusicBrainz links to the artist, from Wikimedia Commons (it is
//      the item the community attached to this very artist, so there is nothing to guess)
//
// Answers are cached (a picture does not change by the hour, and a search lists dozens of artists), concurrent
// lookups of one artist share a single run, and "no picture anywhere" is remembered for a shorter while than a hit.
import { getMusicBrainzRepository } from "~~/server/utils/musicbrainz";
import { getAudioDbArtist } from "~~/server/utils/artistInfo";
import { USER_AGENT } from "~~/server/utils/app";
import { commonsImageUrl, wikidataIdFromRelations, wikidataImageFile, type UrlRelation } from "~~/server/utils/artistImageParse";

const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
// an upstream that was down says nothing about the artist: ask again soon
const UNSURE_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 5_000;
const WIKIDATA_TIMEOUT_MS = 5_000;

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

async function fromWikidata(itemId: string): Promise<Lookup> {
    try {
        const response = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${itemId}&property=P18&format=json`, {
            signal: AbortSignal.timeout(WIKIDATA_TIMEOUT_MS),
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            redirect: "error"
        });
        if (!response.ok) return { image: null, unsure: true };
        const file = wikidataImageFile(await response.json());
        return { image: file ? commonsImageUrl(file) : null, unsure: false };
    } catch {
        return { image: null, unsure: true };
    }
}

async function run(mbid: string, name: string, relations: UrlRelation[] | null | undefined): Promise<Lookup> {
    let unsure = false;

    // TheAudioDB first
    const audioDb = await getAudioDbArtist(name, mbid);
    if (audioDb?.image) return { image: audioDb.image, unsure: false };
    if (audioDb === undefined) unsure = true;

    // ...then the Wikidata item among MusicBrainz' own list of links
    let rels = relations;
    if (!rels) {
        try {
            rels = ((await getMusicBrainzRepository().lookup("artist", mbid, ["url-rels"])) as { relations?: UrlRelation[] }).relations ?? [];
        } catch {
            return { image: null, unsure: true };
        }
    }
    const item = wikidataIdFromRelations(rels);
    if (!item) return { image: null, unsure };
    const wikidata = await fromWikidata(item);
    return { image: wikidata.image, unsure: !wikidata.image && (unsure || wikidata.unsure) };
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
