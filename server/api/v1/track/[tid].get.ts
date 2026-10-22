// [tid].get.ts
import { getMusicBrainzRepository, parseReleaseDate } from "~~/server/utils/musicbrainz";
import type { MediaInfo } from "~~/server/entity/media/MediaInfo";
import type { ArtistInfo } from "~~/server/entity/media/ArtistInfo";
import { IRecording } from "musicbrainz-api";
import { assertMbid } from "~~/server/utils/ids";
import { pickCanonicalRelease } from "~~/server/utils/release";
import { getImageColors } from "~~/server/utils/imageColors";
import { enforceUpstreamLookupLimit } from "~~/server/utils/rateLimit";
import { isReleased, normalizeReleaseDate } from "~~/server/utils/releaseDate";
import { isSubscribed } from "~~/server/core/releaseSubscriptions";
import { hasActiveRequest } from "~~/server/core/requests";
import { findOwnedMediaByIdentity } from "~~/server/core/library";
import { buildIdentity } from "~~/server/utils/mediaIdentity";

defineRouteMeta({
    openAPI: {
        description: "Get track details from a MusicBrainz recording ID",
        tags: ["track"],
        operationId: "getTrack",
        parameters: [
            {
                name: "tid",
                in: "path",
                required: true,
                description: "MusicBrainz recording ID",
                schema: { type: "string" }
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
                                    required: ["albumMbid", "releaseDatePrecision", "released", "subscribed", "requested"],
                                    properties: {
                                        albumMbid: { type: "string", nullable: true, description: "MusicBrainz release-group ID for the track's release, if any" },
                                        releaseDatePrecision: { type: "string", enum: ["day", "month", "year"], nullable: true, description: "How much of releaseDate MusicBrainz actually knows; a partial date is padded to its first day" },
                                        released: { type: "boolean", description: "false while the release date hasn't started anywhere yet - unreleased tracks can't be requested" },
                                        subscribed: { type: "boolean", description: "Whether the caller follows this upcoming track (POST /api/v1/subscriptions)" },
                                        requested: { type: "boolean", description: "Whether the caller has a request for this track that is waiting or being processed - false again once it completed, failed or was denied" }
                                    }
                                }
                            ]
                        }
                    }
                }
            },
            "400": {
                description: "Missing track ID",
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
            "404": {
                description: "No track with that ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    enforceUpstreamLookupLimit(event, userId);

    // SECURITY: interpolated into the upstream MusicBrainz REST path, so it must be a bare UUID and not
    // extra path segments or a query string of the caller's choosing
    const tid = assertMbid(getRouterParam(event, "tid"), "track ID");

    const client = getMusicBrainzRepository();

    const recording: IRecording = await client.lookup("recording", tid, ["artist-credits", "releases", "release-groups", "media", "isrcs"]).catch(() => {
        throw createError({ statusCode: 404, statusMessage: "No track with ID " + tid });
    });

    // same release selection as the album page and the download pipeline (see utils/release.ts), so a
    // track's album/cover/label here match what gets written onto the file when it is downloaded
    const release = pickCanonicalRelease(recording.releases);
    const albumMbid = release?.["release-group"]?.id ?? null;
    const credit = recording["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit ? { name: credit.name, musicbrainzId: credit.id, description: null, image: null } : "Unknown Artist";

    const amId: string | undefined = getAppleMusicTrackID(recording, release);

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
        // same identity match as POST /api/v1/request: this MBID, the one it redirected from, an ISRC, or the
        // same title + artist + duration - the page hides Request when it's true
        inLibrary: await findOwnedMediaByIdentity(userId, buildIdentity({
            mbids: [tid, recording.id],
            isrcs: recording.isrcs,
            title: recording.title,
            artistMbid: credit?.id,
            artistName: credit?.name ?? "Unknown Artist",
            duration: recording.length ? recording.length / 1000 : 0
        })) != null,
        duration: recording.length ? Math.round(recording.length / 1000) : 0,
        label: null,
        relations: {
            amId
        }
    };

    // unreleased tracks can't be requested (POST /api/v1/request refuses them); the page offers a countdown
    // and a release subscription instead
    const released = isReleased(media.releaseDate);
    const subscribed = released ? false : await isSubscribed(userId, recording.id);

    const releaseDatePrecision = normalizeReleaseDate(recording["first-release-date"])?.precision ?? null;

    const requested = await hasActiveRequest(userId, [tid, recording.id]);

    return { ...media, albumMbid, releaseDatePrecision, released, subscribed, requested };
});