import type { IRelease, IReleaseGroup } from "musicbrainz-api";
import { getMusicBrainzClient, parseReleaseDate } from "~~/server/utils/musicbrainz";
import { pickReleaseForGroup } from "~~/server/utils/release";
import type { AlbumDetail } from "~~/server/entity/media/AlbumDetail";
import type { TrackInfo } from "~~/server/entity/media/TrackInfo";
import type { ArtistInfo } from "~~/server/entity/media/ArtistInfo";
import { findLibraryEntry, findMediaByMusicbrainzId } from "~~/server/core/library";
import { hasActiveRequest } from "~~/server/core/requests";
import { isSubscribed } from "~~/server/core/releaseSubscriptions";
import { isReleased, normalizeReleaseDate } from "~~/server/utils/releaseDate";
import { assertMbid } from "~~/server/utils/ids";
import { getImageColors } from "~~/server/utils/imageColors";
import { enforceUpstreamLookupLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "Get full album/EP details (tracklist, artist, cover art) from a MusicBrainz release-group ID, with per-track library/request status for the requesting user",
        tags: ["album"],
        operationId: "getAlbum",
        parameters: [
            {
                name: "aid",
                in: "path",
                required: true,
                description: "MusicBrainz release-group ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            $ref: "#/components/schemas/AlbumDetail"
                        }
                    }
                }
            },
            "400": {
                description: "Missing album ID",
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
                description: "No album/release found for that ID",
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
                    ArtistInfo: {
                        type: "object",
                        required: ["name", "musicbrainzId", "description", "image"],
                        properties: {
                            name: { type: "string" },
                            musicbrainzId: { type: "string" },
                            description: { type: "string", nullable: true },
                            image: { type: "string", nullable: true }
                        }
                    },
                    TrackInfo: {
                        type: "object",
                        required: ["id", "title", "trackNumber", "duration", "releaseDate", "released", "inLibrary", "requested", "mediaId"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz recording ID" },
                            title: { type: "string" },
                            trackNumber: { type: "number" },
                            duration: { type: "number", description: "Seconds" },
                            releaseDate: { type: "string", format: "date-time", nullable: true },
                            released: { type: "boolean", description: "Whether the release date has already passed" },
                            inLibrary: { type: "boolean", description: "Whether the requesting user already has this track" },
                            requested: { type: "boolean", description: "Whether the requesting user has a request for this track that is waiting or being processed" },
                            mediaId: { type: "string", nullable: true, description: "Nafyn's internal media ID, if this recording has been downloaded by anyone" }
                        }
                    },
                    AlbumDetail: {
                        type: "object",
                        required: ["id", "releaseId", "title", "artist", "type", "coverArt", "imageColors", "textColor", "releaseDate", "releaseDatePrecision", "released", "subscribed", "requested", "description", "label", "tracks"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz release-group ID" },
                            releaseId: { type: "string", description: "MusicBrainz release ID for the selected release" },
                            title: { type: "string" },
                            artist: {
                                type: ["object", "string"],
                                oneOf: [
                                    { $ref: "#/components/schemas/ArtistInfo" },
                                    { type: "string" }
                                ]
                            },
                            type: { type: "string", enum: ["album", "ep"], nullable: true },
                            coverArt: { type: "string", nullable: true },
                            imageColors: { type: "array", items: { type: "string" }, description: "Dominant colors extracted from `coverArt`, most-dominant first" },
                            textColor: { type: "string", description: "Black or white, whichever contrasts best (WCAG) against `imageColors[0]`" },
                            releaseDate: { type: "string", format: "date-time", nullable: true },
                            releaseDatePrecision: { type: "string", enum: ["day", "month", "year"], nullable: true, description: "How much of releaseDate MusicBrainz actually knows; a partial date is padded to its first day" },
                            released: { type: "boolean", description: "false while the release date hasn't started anywhere yet - unreleased albums can't be requested" },
                            subscribed: { type: "boolean", description: "Whether the caller follows this upcoming album (POST /api/v1/subscriptions)" },
                            requested: { type: "boolean", description: "Whether the caller has a request for this album that is waiting or being processed - false again once it completed, failed or was denied" },
                            description: { type: "string", nullable: true },
                            label: { type: "string", nullable: true },
                            tracks: {
                                type: "array",
                                items: { $ref: "#/components/schemas/TrackInfo" }
                            }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event): Promise<AlbumDetail> => {
    const { sub: userId } = await requireAuthToken(event);
    enforceUpstreamLookupLimit(event, userId);

    // SECURITY: see the note in track/[tid].get.ts - this reaches an upstream MusicBrainz REST path
    const aid = assertMbid(getRouterParam(event, "aid"), "album ID");

    const client = getMusicBrainzClient();

    const releaseGroup: IReleaseGroup = await client.lookup("release-group", aid, ["artist-credits"]).catch(() => {
        throw createError({ statusCode: 404, message: "No album with ID " + aid });
    });

    const browsed = await client.browse("release", { "release-group": aid }, ["recordings", "artist-credits", "labels", "media", "url-rels"]).catch(() => {
        throw createError({ statusCode: 404, message: "No release found for album " + aid });
    });
    // every Nafyn surface that resolves a release group into a concrete release goes through
    // pickReleaseForGroup, so the tracklist shown here is exactly the one the download pipeline will tag
    // against - and it is the official standard edition, not a promo/bootleg or a +45-track digital deluxe
    const release: IRelease | undefined = pickReleaseForGroup(releaseGroup, browsed.releases);
    if (!release) {
        throw createError({ statusCode: 404, message: "No release found for album " + aid });
    }

    const primaryType = releaseGroup["primary-type"]?.toLowerCase();
    const type = primaryType === "album" || primaryType === "ep" ? primaryType : null;
    const releaseDate = parseReleaseDate(releaseGroup["first-release-date"]);
    const released = isReleased(releaseDate);
    const label = release["label-info"]?.[0]?.label?.name ?? null;
    const credit = releaseGroup["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit ? { name: credit.name, musicbrainzId: credit.id, description: credit.disambiguation || null, image: null } : "Unknown Artist";

    // a track's own recording can carry an earlier/later first-release-date than the album
    // (staggered singles/rollouts); fall back to the album's date when the recording has none
    const tracks: TrackInfo[] = [];
    for (const medium of release.media ?? []) {
        for (const track of medium.tracks ?? []) {
            const trackReleaseDate = parseReleaseDate(track.recording?.["first-release-date"]) ?? releaseDate;
            const media = await findMediaByMusicbrainzId(track.recording.id);
            const inLibrary = media ? await findLibraryEntry(userId, media.id) != null : false;
            const requested = await hasActiveRequest(userId, track.recording.id);

            tracks.push({
                id: track.recording.id,
                title: track.title,
                trackNumber: track.position,
                duration: track.length ? Math.round(track.length / 1000) : 0,
                releaseDate: trackReleaseDate,
                released: isReleased(trackReleaseDate),
                inLibrary,
                requested,
                mediaId: media?.id ?? null
            });
        }
    }

    const coverArt = `https://coverartarchive.org/release-group/${releaseGroup.id}/front-500`;
    const { imageColors, textColor } = await getImageColors({ coverArtUrl: coverArt });

    return {
        id: releaseGroup.id,
        releaseId: release.id,
        title: releaseGroup.title,
        artist,
        type,
        coverArt,
        imageColors,
        textColor,
        releaseDate,
        releaseDatePrecision: normalizeReleaseDate(releaseGroup["first-release-date"])?.precision ?? null,
        released,
        subscribed: released ? false : await isSubscribed(userId, releaseGroup.id),
        requested: await hasActiveRequest(userId, releaseGroup.id),
        description: releaseGroup.disambiguation || null,
        label,
        tracks
    };
});
