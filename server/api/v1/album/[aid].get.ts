import type { IRelease, IReleaseGroup } from "musicbrainz-api";
import { getMusicBrainzClient, parseReleaseDate } from "~~/server/utils/musicbrainz";
import { pickReleaseForGroup } from "~~/server/utils/release";
import type { AlbumDetail } from "~~/server/entity/media/AlbumDetail";
import type { TrackInfo } from "~~/server/entity/media/TrackInfo";
import type { ArtistInfo } from "~~/server/entity/media/ArtistInfo";
import { findLibraryEntry, findMediaByMusicbrainzId } from "~~/server/core/library";
import { hasActiveRequest } from "~~/server/core/requests";
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
                            requested: { type: "boolean", description: "Whether the requesting user has an active (non-failed) request for this track" },
                            mediaId: { type: "string", nullable: true, description: "Nafyn's internal media ID, if this recording has been downloaded by anyone" }
                        }
                    },
                    AlbumDetail: {
                        type: "object",
                        required: ["id", "releaseId", "title", "artist", "type", "coverArt", "imageColors", "textColor", "releaseDate", "description", "label", "tracks"],
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
    const { sub: userId } = requireAuthToken(event);
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
    const label = release["label-info"]?.[0]?.label?.name ?? null;
    const credit = releaseGroup["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit ? { name: credit.name, musicbrainzId: credit.id, description: credit.disambiguation || null, image: null } : "Unknown Artist";

    // a track's own recording can carry an earlier/later first-release-date than the album
    // (staggered singles/rollouts); fall back to the album's date when the recording has none
    const now = Date.now();
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
                released: trackReleaseDate ? trackReleaseDate.getTime() <= now : true,
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
        description: releaseGroup.disambiguation || null,
        label,
        tracks
    };
});
