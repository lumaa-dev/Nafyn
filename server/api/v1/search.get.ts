import type { IArtist } from "musicbrainz-api";
import { getMusicBrainzRepository } from "../../utils/musicbrainz";
import { MusicBrainzError, escapeLucene } from "../../utils/musicbrainzRepository";
import { getSearchDeps } from "../../utils/catalogSearch";
import { searchAlbums, searchTracks, type SearchInput } from "../../utils/search/engine";
import type { SearchResult } from "../../utils/search/types";
import { getAlbumContents, type AlbumContents } from "../../utils/albumContents";
import { getLastfmArtistInfo } from "../../utils/lastfm";
import { requireAuthToken } from "../../utils/requireAuth";
import { consumeRateLimit } from "../../utils/rateLimit";
import type { MediaInfo } from "../../entity/media/MediaInfo";
import type { ArtistInfo } from "../../entity/media/ArtistInfo";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// this endpoint fans out to MusicBrainz (and Last.fm) on every call, so an authenticated account could
// otherwise use Nafyn as a free proxy to hammer those upstreams - and get Nafyn's own IP blocked there
const MAX_SEARCHES = 60;

// the most artists of an album that also get a Last.fm lookup (a compilation can credit hundreds)
const MAX_ARTIST_IMAGES = 10;
const SEARCH_WINDOW_MS = 60 * 1000;

type Filter = "album" | "track" | "artist" | "all";

defineRouteMeta({
    openAPI: {
        description: "Search MusicBrainz for albums, tracks, and/or artists. Albums and tracks are normalized, filtered (Official digital releases only, no bootlegs/compilations/deluxe/remasters unless asked for) and ranked; results with a front cover come first. At most one result has `bestResult: true`. Free text may name the artist and the title together, in any order, with words left out or misspelled (\"lovejoy one trick\"). When `filter` is `all` and the best result is an album, the response is about that album: `artists` is every artist credited on it (featurings included) and `tracks` starts with all of its tracks, in order (flagged `from_album`), followed by the other matching tracks.",
        tags: ["search"],
        operationId: "search",
        parameters: [
            {
                name: "q",
                in: "query",
                required: true,
                description: "Free-text search query. Optional when `title` or `artist` is given. \"Artist - Title\" is tried in both orders.",
                schema: { type: "string" }
            },
            {
                name: "title",
                in: "query",
                required: false,
                description: "Song or album title. Takes precedence over the title part of `q`.",
                schema: { type: "string" }
            },
            {
                name: "artist",
                in: "query",
                required: false,
                description: "Artist name (any language: aliases are matched).",
                schema: { type: "string" }
            },
            {
                name: "upc",
                in: "query",
                required: false,
                description: "UPC-A/EAN-13 barcode (12 or 13 digits, valid check digit) of the album. Strong identity evidence for `albums`; needs `title` and `artist` as fallback. An invalid code is ignored.",
                schema: { type: "string" }
            },
            {
                name: "isrc",
                in: "query",
                required: false,
                description: "ISRC of the track (12 characters, hyphens allowed). Strong identity evidence for `tracks`; needs `title` and `artist` as fallback. An invalid code is ignored.",
                schema: { type: "string" }
            },
            {
                name: "filter",
                in: "query",
                required: false,
                description: "Restrict results to one result type, defaults to `all`",
                schema: { type: "string", enum: ["album", "track", "artist", "all"] }
            },
            {
                name: "limit",
                in: "query",
                required: false,
                description: `Max results per category, defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}`,
                schema: { type: "number" }
            },
            {
                name: "offset",
                in: "query",
                required: false,
                description: "Offset into the ranked list, defaults to 0",
                schema: { type: "number" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["albums", "tracks", "artists"],
                            properties: {
                                albums: {
                                    type: "array",
                                    items: { $ref: "#/components/schemas/MediaInfo" }
                                },
                                tracks: {
                                    type: "array",
                                    items: { $ref: "#/components/schemas/MediaInfo" }
                                },
                                artists: {
                                    type: "array",
                                    items: { $ref: "#/components/schemas/ArtistInfo" }
                                }
                            }
                        }
                    }
                }
            },
            "400": {
                description: "Nothing to search for (`q`, `title` or `artist`), or `upc`/`isrc` without both `title` and `artist`",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "503": {
                description: "MusicBrainz is unreachable or overloaded",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        },
        $global: {
            components: {
                schemas: {
                    MediaInfo: {
                        type: "object",
                        required: ["id", "title", "artist", "album", "type", "coverArt", "releaseDate", "inLibrary", "duration", "label"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz ID (recording or release-group)" },
                            title: { type: "string" },
                            artist: {
                                type: ["object", "string"],
                                oneOf: [
                                    { $ref: "#/components/schemas/ArtistInfo" },
                                    { type: "string" }
                                ]
                            },
                            album: {
                                type: "object",
                                nullable: true,
                                properties: {
                                    id: { type: "string", nullable: true },
                                    type: { type: "string", enum: ["album", "ep"], nullable: true },
                                    title: { type: "string", nullable: true }
                                }
                            },
                            type: { type: "string", enum: ["album", "ep", "track"], nullable: true },
                            coverArt: { type: "string", nullable: true },
                            imageColors: { type: "array", items: { type: "string" }, description: "Dominant colors extracted from `coverArt`, most-dominant first; only present on single-item lookups (getTrack/getTrackByIsrc)" },
                            textColor: { type: "string", description: "Black or white, whichever contrasts best (WCAG) against `imageColors[0]`; only present alongside `imageColors`" },
                            releaseDate: { type: "string", format: "date-time", nullable: true },
                            inLibrary: { type: "boolean", nullable: true },
                            duration: { type: "number", description: "Seconds" },
                            label: { type: "string", nullable: true },
                            relations: {
                                type: "object",
                                description: "Cross-service identifiers, only present on some lookups",
                                properties: {
                                    amId: { type: "string", description: "Apple Music identifier" }
                                }
                            },
                            bestResult: {
                                type: "boolean",
                                description: "Only on album/track search results. True on at most one result: the top-ranked one, when it clears the minimum score, has a front cover or an exact UPC/ISRC match, and clearly beats the runner-up. False everywhere when the top results are too close to call."
                            },
                            match: { $ref: "#/components/schemas/SearchMatch" }
                        }
                    },
                    SearchMatch: {
                        type: "object",
                        description: "Score breakdown of an album/track search result",
                        required: ["title", "artist", "relevance", "exactness", "sources", "flags", "hasFrontCover"],
                        properties: {
                            title: { type: "number", description: "Containment score of the title, 0..1 (1 when no title was given)" },
                            artist: { type: "number", description: "Best artist similarity over name, aliases and sort names, 0..1 (1 when no artist was given)" },
                            relevance: { type: "number", description: "Weighted title/artist score plus corroboration and UPC/ISRC bonuses, may exceed 1" },
                            exactness: { type: "number", description: "Levenshtein ratio of the normalized titles, 0..1" },
                            sources: { type: "number", description: "How many independent searches found this result" },
                            hasFrontCover: { type: "boolean", description: "The best qualifying release has a front cover. Results with one rank first." },
                            flags: {
                                type: "array",
                                items: { type: "string", enum: ["upc_match", "isrc_match", "code_contradiction", "artist_only", "swapped_order", "transliterated", "artist_in_query", "from_album", "no_front_cover"] }
                            }
                        }
                    }
                }
            }
        }
    },
});

function toArtistInfo(artist: IArtist): ArtistInfo {
    return {
        name: artist.name,
        musicbrainzId: artist.id,
        description: artist.disambiguation || null,
        image: null
    };
}

// only applied to the top-level "artists" results (where ArtistBox.vue actually renders `image`) - not to
// every album/track's artist credit too, which would multiply Last.fm calls for no visible benefit
async function withLastfmImage(info: ArtistInfo): Promise<ArtistInfo> {
    if (!info.musicbrainzId) return info;
    const lastfm = await getLastfmArtistInfo(info.name, info.musicbrainzId);
    return lastfm?.image ? { ...info, image: lastfm.image } : info;
}

function parseReleaseDate(date: string | null): Date | null {
    if (!date) return null;
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toArtist(result: SearchResult): ArtistInfo {
    return { name: result.artist.name, musicbrainzId: result.artist.id ?? "", description: null, image: null };
}

function toMatch(result: SearchResult) {
    return { ...result.match, hasFrontCover: result.hasFrontCover };
}

function albumToMediaInfo(result: SearchResult): SearchMediaInfo {
    const primaryType = result.primaryType?.toLowerCase();

    return {
        id: result.id,
        title: result.title,
        artist: toArtist(result),
        album: null,
        type: primaryType === "album" || primaryType === "ep" ? primaryType : null,
        coverArt: `https://coverartarchive.org/release-group/${result.id}/front-250`,
        releaseDate: parseReleaseDate(result.releaseDate),
        inLibrary: false,
        duration: 0,
        label: null,
        bestResult: result.bestResult,
        match: toMatch(result)
    };
}

function trackToMediaInfo(result: SearchResult): SearchMediaInfo {
    const albumType = result.primaryType?.toLowerCase();

    return {
        id: result.id,
        title: result.title,
        artist: toArtist(result),
        album: {
            title: result.releaseTitle,
            id: result.albumId,
            type: albumType === "album" || albumType === "ep" ? albumType : null
        },
        type: "track",
        coverArt: result.releaseId ? `https://coverartarchive.org/release/${result.releaseId}/front-250` : null,
        releaseDate: parseReleaseDate(result.releaseDate),
        inLibrary: false,
        duration: result.length ? Math.round(result.length / 1000) : 0,
        label: null,
        bestResult: result.bestResult,
        match: toMatch(result)
    };
}

type SearchMediaInfo = Omit<MediaInfo, "relations"> & { bestResult: boolean, match: ReturnType<typeof toMatch> };

// a track of the album that came back as the best result, shaped like any other track result
function albumTrackToMediaInfo(track: AlbumContents["tracks"][number], album: AlbumContents, best: SearchResult): SearchMediaInfo {
    return {
        id: track.id,
        title: track.title,
        artist: { name: track.artist.name, musicbrainzId: track.artist.id ?? "", description: null, image: null },
        album: { title: album.albumTitle, id: album.albumId, type: album.albumType },
        type: "track",
        coverArt: `https://coverartarchive.org/release/${album.releaseId}/front-250`,
        releaseDate: parseReleaseDate(track.releaseDate ?? album.releaseDate),
        inLibrary: false,
        duration: track.length ? Math.round(track.length / 1000) : 0,
        label: null,
        bestResult: false,
        match: { ...toMatch(best), title: 1, artist: 1, exactness: 1, sources: 1, flags: ["from_album"] }
    };
}

/**
 * The best-result album's tracks and artists, or null when there is none to speak of (no confident album, or
 * MusicBrainz cannot say what is on it - the plain results are then still a good answer).
 */
async function albumOfBestResult(albums: SearchResult[]): Promise<{ album: AlbumContents, best: SearchResult } | null> {
    const best = albums.find((result) => result.bestResult);
    if (!best) return null;
    try {
        const album = await getAlbumContents(getMusicBrainzRepository(), best.id);
        return album ? { album, best } : null;
    } catch (error) {
        console.warn(`[search] could not read the tracklist of ${best.id}: ${(error as Error).message}`);
        return null;
    }
}

function param(value: unknown): string {
    return (typeof value === "string" ? value.trim() : "").slice(0, 200);
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const rateLimit = consumeRateLimit(`search:${userId}`, MAX_SEARCHES, SEARCH_WINDOW_MS);
    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many searches, slow down" });
    }

    const query = getQuery(event);
    const input: SearchInput = {
        q: param(query?.q),
        title: param(query?.title),
        artist: param(query?.artist),
        upc: param(query?.upc),
        isrc: param(query?.isrc)
    };
    const filter: Filter = query?.filter === "album" || query?.filter === "track" || query?.filter === "artist" ? query.filter : "all";

    if (!input.q && !input.title && !input.artist) {
        throw createError({ statusCode: 400, statusMessage: "Missing search query: give `q`, `title` or `artist`" });
    }
    // a code is evidence, not the whole request: when it fails to match, title + artist are what gets searched
    if ((input.upc || input.isrc) && (!input.title || !input.artist)) {
        throw createError({ statusCode: 400, statusMessage: "`upc` and `isrc` need `title` and `artist` as a fallback" });
    }

    // clamped on both ends: a negative or fractional limit went straight to MusicBrainz and came back a 500
    const limit = Math.min(Math.max(Math.trunc(Number(query?.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.min(Math.max(Math.trunc(Number(query?.offset)) || 0, 0), 10_000);

    const deps = getSearchDeps();
    const artistText = input.artist || input.q || input.title || "";

    try {
        const [albums, tracks, artists] = await Promise.all([
            filter === "all" || filter === "album" ? searchAlbums(input, deps, limit, offset) : null,
            filter === "all" || filter === "track" ? searchTracks(input, deps, limit, offset) : null,
            filter === "all" || filter === "artist"
                ? getMusicBrainzRepository().search("artist", { query: artistText.split(/\s+/).filter(Boolean).map(escapeLucene).join(" "), limit, offset })
                : null
        ]);

        // an album is the answer: what is on it is the answer too (first page only, `offset` pages through the rest)
        const content = filter === "all" && albums && offset === 0 ? await albumOfBestResult(albums.results) : null;

        let trackInfos: SearchMediaInfo[] = tracks ? tracks.results.map(trackToMediaInfo) : [];
        let artistInfos: ArtistInfo[];
        if (content) {
            const onAlbum = content.album.tracks.map((track) => albumTrackToMediaInfo(track, content.album, content.best));
            const seen = new Set(onAlbum.map((track) => track.id));
            // the album's tracks are never cut by `limit`; the other matches fill what is left of it
            trackInfos = [...onAlbum, ...trackInfos.filter((track) => !seen.has(track.id))].slice(0, Math.max(limit, onAlbum.length));
            artistInfos = await Promise.all(content.album.artists.map((artist, index): Promise<ArtistInfo> | ArtistInfo => {
                const info: ArtistInfo = { name: artist.name, musicbrainzId: artist.id, description: artist.disambiguation, image: null };
                return index < MAX_ARTIST_IMAGES ? withLastfmImage(info) : info;
            }));
        } else {
            artistInfos = artists ? await Promise.all(artists.artists.map(toArtistInfo).map(withLastfmImage)) : [];
        }

        return {
            albums: albums ? albums.results.map(albumToMediaInfo) : [],
            tracks: trackInfos,
            artists: artistInfos
        };
    } catch (error) {
        if (error instanceof MusicBrainzError) {
            setResponseHeader(event, "Retry-After", 30);
            throw createError({ statusCode: 503, statusMessage: "MusicBrainz is unavailable, try again later" });
        }
        throw error;
    }
});
