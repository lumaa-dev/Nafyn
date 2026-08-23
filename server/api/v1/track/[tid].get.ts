// [tid].get.ts
import { getMusicBrainzClient, parseReleaseDate } from "~~/server/utils/musicbrainz";
import type { MediaInfo } from "~~/server/entity/media/MediaInfo";
import type { ArtistInfo } from "~~/server/entity/media/ArtistInfo";
import { IRecording } from "musicbrainz-api";
import { assertMbid } from "~~/server/utils/ids";

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
                                    required: ["albumMbid"],
                                    properties: {
                                        albumMbid: { type: "string", nullable: true, description: "MusicBrainz release-group ID for the track's release, if any" }
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
    requireAuthToken(event);

    // SECURITY: interpolated into the upstream MusicBrainz REST path, so it must be a bare UUID and not
    // extra path segments or a query string of the caller's choosing
    const tid = assertMbid(getRouterParam(event, "tid"), "track ID");

    const client = getMusicBrainzClient();

    const recording: IRecording = await client.lookup("recording", tid, ["artist-credits", "releases", "release-groups", "media"]).catch(() => {
        throw createError({ statusCode: 404, statusMessage: "No track with ID " + tid });
    });

    // prefer the "Digital Media" release: it best matches what we actually distribute,
    // while CD/Vinyl releases (often the first one MusicBrainz returns) can differ in title/label/cover art
    const release = recording.releases?.find((r) => r.media?.some((m) => m.format === "Digital Media")) ?? recording.releases?.[0];
    const albumMbid = release?.["release-group"]?.id ?? null;
    const credit = recording["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit ? { name: credit.name, musicbrainzId: credit.id, description: null, image: null } : "Unknown Artist";

    const amId: string | undefined = getAppleMusicTrackID(recording, release);

    const media: MediaInfo = {
        id: recording.id,
        title: recording.title,
        artist,
        album: release ? { id: albumMbid, type: null, title: release.title } : null,
        type: "track",
        coverArt: release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
        releaseDate: parseReleaseDate(recording["first-release-date"]),
        inLibrary: null,
        duration: recording.length ? Math.round(recording.length / 1000) : 0,
        label: null,
        relations: {
            amId
        }
    };

    return { ...media, albumMbid };
});