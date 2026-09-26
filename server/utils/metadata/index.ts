// unified song metadata facade over Deezer, iTunes, ReccoBeats, Discogs, TheAudioDB and Genius. Each provider
// is one file under ./providers implementing MetadataProvider (types.ts); adding one means writing that file
// and appending it to PROVIDERS. A provider whose key/token isn't configured reports enabled() === false and
// is skipped silently, as is one that fails, times out or is cooling down after a rate limit (http.ts) - a
// lookup never fails because one upstream did.
import type { IRecording, IReleaseGroup } from "musicbrainz-api";
import { getMusicBrainzClient } from "../musicbrainz";
import { deezerProvider } from "./providers/deezer";
import { itunesProvider } from "./providers/itunes";
import { reccobeatsProvider } from "./providers/reccobeats";
import { discogsProvider } from "./providers/discogs";
import { theaudiodbProvider } from "./providers/theaudiodb";
import { geniusProvider } from "./providers/genius";
import { parseMetadataQuery } from "./query";
import type { MetadataLookupResult, MetadataProvider, MetadataQuery, SongMetadata, TextQuery } from "./types";

// keyless, public providers first: their results lead the list, and they're the ones asked first
const PROVIDERS: MetadataProvider[] = [
    deezerProvider,
    itunesProvider,
    reccobeatsProvider,
    theaudiodbProvider,
    discogsProvider,
    geniusProvider
];

// strict MusicBrainz fallback for records without an ISRC: anything below this is too loose to link
const MIN_MUSICBRAINZ_SCORE = 90;

export function listMetadataProviders() {
    return PROVIDERS.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled(),
        search: !!p.search,
        isrc: !!p.byIsrc,
        idLookup: !!p.byId
    }));
}

function enabled(): MetadataProvider[] {
    return PROVIDERS.filter((p) => p.enabled());
}

// runs one call per provider in parallel and keeps whatever came back, in provider order
async function fanOut(providers: MetadataProvider[], call: (p: MetadataProvider) => Promise<SongMetadata[]> | undefined): Promise<SongMetadata[]> {
    const settled = await Promise.allSettled(providers.map((p) => call(p) ?? Promise.resolve([])));
    return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
}

function searchAll(query: TextQuery, limit: number): Promise<SongMetadata[]> {
    return fanOut(enabled(), (p) => p.search?.(query, limit));
}

// strips version suffixes providers disagree on - `(Remastered 2009)`, `[Live]`, ` - Radio Edit` - so the
// other providers get searched with the song's bare title
function bareTitle(title: string): string {
    return title.replace(/\s*[([][^)\]]*[)\]]/g, "").replace(/\s+-\s+.*$/, "").trim() || title;
}

function normalize(value: string): string {
    return bareTitle(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// text searches are fuzzy (iTunes happily answers "Yellow Submarine" with another Beatles song), so an
// enrichment hit has to share an artist with the primary record and, if it's a track, its title too
function sameSong(primary: SongMetadata, candidate: SongMetadata): boolean {
    const artist = normalize(primary.artists[0]!);
    const artistMatches = candidate.artists.some((a) => {
        const other = normalize(a);
        return other === artist || other.includes(artist) || artist.includes(other);
    });
    if (!artistMatches) return false;
    return candidate.kind === "album" || normalize(candidate.title) === normalize(primary.title);
}

const ENRICH_CANDIDATES = 3;

// an ISRC or ID lookup lands on one record; the other providers are then searched by its artist and title
// for whatever they add (genres, audio features, credits, descriptions...), keeping each one's best match
async function enrich(primary: SongMetadata[]): Promise<SongMetadata[]> {
    const first = primary[0];
    if (!first?.artists[0]) return primary;

    const title = bareTitle(first.title);
    const query: TextQuery = { type: "text", text: `${first.artists[0]} - ${title}`, artist: first.artists[0], title };
    const others = enabled().filter((p) => p.id !== first.provider && p.search);
    const settled = await Promise.allSettled(others.map((p) => p.search!(query, ENRICH_CANDIDATES)));
    const related = settled.flatMap((s) => {
        const match = s.status === "fulfilled" ? s.value.find((c) => sameSong(first, c)) : undefined;
        return match ? [match] : [];
    });

    return [...primary, ...related];
}

function luceneEscape(value: string): string {
    return value.replace(/[\\"]/g, "\\$&");
}

// resolves one record to the MusicBrainz entity it opens as in Nafyn: a recording for a track (`/t/{id}`),
// a release-group for an album (`/a/{id}`, Discogs' native kind). ISRC first when there is one - far more
// precise than a title+artist search - then a strict score-gated search as the fallback.
async function resolveMusicBrainzFor(record: SongMetadata): Promise<string | null> {
    if (record.kind === "track" && record.musicbrainzId) return record.musicbrainzId;
    if (!record.artists[0]) return null;

    const client = getMusicBrainzClient();
    const artist = luceneEscape(record.artists[0]);

    try {
        if (record.kind === "track") {
            if (record.isrc) {
                const byIsrc = await client.search("recording", { query: `isrc:${record.isrc}`, limit: 1 });
                if (byIsrc.recordings?.[0]) return byIsrc.recordings[0].id;
            }
            const byName = await client.search("recording", {
                query: `recording:"${luceneEscape(record.title)}" AND artist:"${artist}"`,
                limit: 1
            });
            const best = byName.recordings?.[0] as (IRecording & { score?: number }) | undefined;
            return best && (best.score ?? 0) >= MIN_MUSICBRAINZ_SCORE ? best.id : null;
        }

        const byName = await client.search("release-group", {
            query: `releasegroup:"${luceneEscape(bareTitle(record.title))}" AND artist:"${artist}"`,
            limit: 1
        });
        const best = byName["release-groups"]?.[0] as (IReleaseGroup & { score?: number }) | undefined;
        return best && (best.score ?? 0) >= MIN_MUSICBRAINZ_SCORE ? best.id : null;
    } catch {
        return null;
    }
}

// only ever fed the primary records: enrichment hits are matched on the bare title, so they may well be a
// different version (the studio take of a requested acoustic one) with a different MBID
async function resolveMusicBrainz(records: SongMetadata[]): Promise<string | null> {
    for (const record of records) {
        const id = await resolveMusicBrainzFor(record);
        if (id) return id;
    }
    return null;
}

// resolves a single record fetched fresh by its own `ref` (`provider:kind:id`) - used to open a text-search
// hit (each one a different song, so lookupMetadata's one-resolution-for-the-whole-batch doesn't apply) or an
// enrichment record of a different kind than the primary (e.g. a Discogs album next to a track), on demand
// when the user actually clicks it rather than for every result up front.
export async function resolveMetadataRef(ref: string): Promise<{ kind: "track" | "album", musicbrainzId: string } | null> {
    const query = parseMetadataQuery(ref);
    if (!query || query.type !== "id") return null;

    const provider = enabled().find((p) => p.id === query.provider);
    const record = provider?.byId ? await provider.byId(query.kind, query.id).catch(() => null) : null;
    if (!record) return null;

    const musicbrainzId = record.musicbrainzId ?? await resolveMusicBrainzFor(record);
    return musicbrainzId ? { kind: record.kind, musicbrainzId } : null;
}

export async function lookupMetadata(query: MetadataQuery, limit = 5): Promise<MetadataLookupResult> {
    const providers = enabled().map((p) => p.id);

    if (query.type === "text") {
        return { query, musicbrainzId: null, results: await searchAll(query, limit), providers };
    }

    let primary: SongMetadata[];
    if (query.type === "isrc") {
        primary = await fanOut(enabled(), (p) => p.byIsrc?.(query.isrc));
    } else {
        const provider = enabled().find((p) => p.id === query.provider);
        const record = provider?.byId ? await provider.byId(query.kind, query.id).catch(() => null) : null;
        primary = record ? [record] : [];
    }

    const [results, musicbrainzId] = await Promise.all([enrich(primary), resolveMusicBrainz(primary)]);
    // the whole batch is one song/album (enrich() only keeps sameSong() matches), so every result of the
    // primary's own kind opens on the same MusicBrainz entity - an enrichment record of a *different* kind
    // (a Discogs album pulled in next to a track) is left for resolveMetadataRef to resolve on click instead
    const primaryKind = primary[0]?.kind;
    const resolved = musicbrainzId && primaryKind
        ? results.map((r) => (r.kind === primaryKind ? { ...r, musicbrainzId: r.musicbrainzId ?? musicbrainzId } : r))
        : results;

    return { query, musicbrainzId, results: resolved, providers };
}
