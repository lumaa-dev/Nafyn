import type { IArtist, IArtistCredit, IRecording, IReleaseGroup } from "musicbrainz-api";
import { getMusicBrainzClient } from "../../utils/musicbrainz";
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
const SEARCH_WINDOW_MS = 60 * 1000;

type Filter = "album" | "track" | "artist" | "all";

defineRouteMeta({
    openAPI: {
        description: "Search MusicBrainz for albums, tracks, and/or artists",
        tags: ["search"],
        operationId: "search",
        parameters: [
            {
                name: "q",
                in: "query",
                required: true,
                description: "Search query",
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
                description: "Pagination offset, defaults to 0",
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
                description: "Missing search query `q`",
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

function creditToArtistInfo(credit: IArtistCredit[] | undefined): ArtistInfo {
    const artist = credit?.[0]?.artist;
    return artist ? toArtistInfo(artist) : { name: "Unknown Artist", musicbrainzId: "", description: null, image: null };
}

function parseReleaseDate(date: string | undefined): Date | null {
    if (!date) return null;
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function releaseGroupToMediaInfo(releaseGroup: IReleaseGroup): MediaInfo {
    const primaryType = releaseGroup["primary-type"]?.toLowerCase();

    return {
        id: releaseGroup.id,
        title: releaseGroup.title,
        artist: creditToArtistInfo(releaseGroup["artist-credit"]),
        album: null,
        type: primaryType === "album" || primaryType === "ep" ? primaryType : null,
        coverArt: `https://coverartarchive.org/release-group/${releaseGroup.id}/front-250`,
        releaseDate: parseReleaseDate(releaseGroup["first-release-date"]),
        inLibrary: false,
        duration: 0,
        label: null
    };
}

function recordingToMediaInfo(recording: IRecording): MediaInfo {
    const release = recording.releases?.[0];

    return {
        id: recording.id,
        title: recording.title,
        artist: creditToArtistInfo(recording["artist-credit"]),
        album: {
            title: release?.title ?? null,
            id: release?.id ?? null,
            type: null
        },
        type: "track",
        coverArt: release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
        releaseDate: parseReleaseDate(recording["first-release-date"]),
        inLibrary: false,
        duration: recording.length ? Math.round(recording.length / 1000) : 0,
        label: null
    };
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const rateLimit = consumeRateLimit(`search:${userId}`, MAX_SEARCHES, SEARCH_WINDOW_MS);
    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many searches, slow down" });
    }

    const query = getQuery(event);
    const q = (typeof query?.q === "string" ? query.q.trim() : "").slice(0, 200);
    const filter: Filter = query?.filter === "album" || query?.filter === "track" || query?.filter === "artist" ? query.filter : "all";

    if (!q) {
        throw createError({ statusCode: 400, statusMessage: "Missing search query `q`" });
    }

    const limit = Math.min(Number(query?.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(Number(query?.offset) || 0, 0);

    const client = getMusicBrainzClient();

    const [albums, tracks, artists] = await Promise.all([
        filter === "all" || filter === "album"
            ? client.search("release-group", { query: q, limit, offset })
            : null,
        filter === "all" || filter === "track"
            ? client.search("recording", { query: q, limit, offset })
            : null,
        filter === "all" || filter === "artist"
            ? client.search("artist", { query: q, limit, offset })
            : null
    ]);

    const artistInfos = artists ? await Promise.all(artists.artists.map(toArtistInfo).map(withLastfmImage)) : [];

    return {
        albums: albums ? albums["release-groups"].map(releaseGroupToMediaInfo) : [],
        tracks: tracks ? tracks.recordings.map(recordingToMediaInfo) : [],
        artists: artistInfos
    };
});
