import { getMusicBrainzRepository, parseReleaseDate, TRACK_LOOKUP_INC } from "~~/server/utils/musicbrainz";
import { MusicBrainzError } from "~~/server/utils/musicbrainzRepository";
import { resolveDescribedTrack } from "~~/server/core/trackResolve";
import type { MediaInfo } from "~~/server/entity/media/MediaInfo";
import type { ArtistInfo } from "~~/server/entity/media/ArtistInfo";
import type { IRecording, RecordingIncludes } from "musicbrainz-api";
import { pickCanonicalRelease } from "~~/server/utils/release";
import { getImageColors } from "~~/server/utils/imageColors";
import { enforceUpstreamLookupLimit } from "~~/server/utils/rateLimit";


const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/i;

defineRouteMeta({
    openAPI: {
        description: "Look up a track by its ISRC (International Standard Recording Code). When several recordings share the ISRC, the one whose title, artist and length agree with `title`, `artist` and `duration` is returned. When MusicBrainz knows no recording with that ISRC (or the ISRC is a `ZZ` placeholder) and `title` and `artist` are given, the track is searched by title + artist with the same engine as `GET /api/v1/search` (Official releases of any format here, the core title and the first of several artists tried too) and the best match is returned if it is relevant enough - or, with `duration`, if its length agrees.",
        tags: ["track"],
        operationId: "getTrackByIsrc",
        parameters: [
            {
                name: "isrc",
                in: "path",
                required: true,
                description: "ISRC, e.g. `USRC17607839`",
                schema: { type: "string" }
            },
            {
                name: "title",
                in: "query",
                required: false,
                description: "Track title, fallback when no recording has this ISRC. Needs `artist` too.",
                schema: { type: "string" }
            },
            {
                name: "artist",
                in: "query",
                required: false,
                description: "Artist name, fallback when no recording has this ISRC. Needs `title` too.",
                schema: { type: "string" }
            },
            {
                name: "duration",
                in: "query",
                required: false,
                description: "Track length in seconds as the other service reports it: picks between recordings sharing the ISRC, and backs a search match",
                schema: { type: "integer" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            allOf: [
                                { $ref: "#/components/schemas/MediaInfo" },
                                {
                                    type: "object",
                                    required: ["albumMbid", "searchFallback"],
                                    properties: {
                                        albumMbid: { type: "string", nullable: true, description: "MusicBrainz release-group ID for the track's release, if any" },
                                        searchFallback: { type: "boolean", description: "True when no recording had this ISRC and the track was found by searching `title` + `artist` instead" }
                                    }
                                }
                            ]
                        }
                    }
                }
            },
            "400": {
                description: "Invalid or missing ISRC",
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
                description: "MusicBrainz is unreachable or overloaded; see Retry-After",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "No song found for that ISRC, nor (when `title` and `artist` were given) by title + artist",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

function param(value: unknown): string {
    return (typeof value === "string" ? value.trim() : "").slice(0, 200);
}

function seconds(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed < 24 * 3600 ? Math.round(parsed) : undefined;
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    enforceUpstreamLookupLimit(event, userId);

    const isrc = getRouterParam(event, "isrc");
    if (!isrc || !ISRC_PATTERN.test(isrc)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid or missing ISRC" });
    }

    const query = getQuery(event);
    const title = param(query?.title);
    const artistName = param(query?.artist);
    const duration = seconds(query?.duration);

    const client = getMusicBrainzRepository();

    let recording: IRecording;
    let searchFallback: boolean;
    try {
        const resolved = await resolveDescribedTrack({ isrc, title, artist: artistName, duration });
        if (!resolved) {
            throw createError({
                statusCode: 404,
                statusMessage: title && artistName
                    ? "No song found for ISRC " + isrc + " or for that title and artist"
                    : "No song found for ISRC " + isrc + " (give `title` and `artist` to search by name instead)"
            });
        }
        searchFallback = resolved.via === "search";
        // the include list resolveTargets uses too, so the request that usually follows this lookup costs nothing
        recording = await client.lookup("recording", resolved.recordingId, TRACK_LOOKUP_INC as RecordingIncludes[]);
    } catch (error) {
        if (error instanceof MusicBrainzError) {
            if (error.status === 404 || error.status === 400) throw createError({ statusCode: 404, statusMessage: "No song found for ISRC " + isrc });
            setResponseHeader(event, "Retry-After", 30);
            throw createError({ statusCode: 503, statusMessage: "MusicBrainz is unavailable, try again later" });
        }
        throw error;
    }

    // the same release the track page and the download pipeline pick, so the album shown here is the one tagged
    const release = pickCanonicalRelease(recording.releases);
    const albumMbid = release?.["release-group"]?.id ?? null;
    const credit = recording["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit
        ? { name: credit.name, musicbrainzId: credit.id, description: null, image: null }
        : "Unknown Artist";

    const coverArt = release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null;
    const { imageColors, textColor } = await getImageColors({ coverArtUrl: coverArt });

    const media: MediaInfo = {
        id: recording.id,
        title: recording.title,
        artist,
        album: release ? { id: albumMbid, type: null, title: release.title } : null,
        type: "track",
        coverArt,
        imageColors,
        textColor,
        releaseDate: parseReleaseDate(recording["first-release-date"]),
        inLibrary: null,
        duration: recording.length ? Math.round(recording.length / 1000) : 0,
        label: null
    };

    return { ...media, albumMbid, searchFallback };
});
