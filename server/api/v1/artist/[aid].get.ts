import type { IReleaseGroup } from "musicbrainz-api";
import { getMusicBrainzClient, parseReleaseDate } from "~~/server/utils/musicbrainz";
import { getLastfmArtistInfo } from "~~/server/utils/lastfm";
import { userOwnsAlbum } from "~~/server/core/library";
import type { ArtistDetail } from "~~/server/entity/media/ArtistDetail";
import type { MediaInfo } from "~~/server/entity/media/MediaInfo";

defineRouteMeta({
    openAPI: {
        description: "Get artist details: name, Last.fm bio/image (if LASTFM_API_KEY is configured), and their discography from MusicBrainz with per-album library status for the requesting user",
        tags: ["artist"],
        operationId: "getArtist",
        parameters: [
            {
                name: "aid",
                in: "path",
                required: true,
                description: "MusicBrainz artist ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/ArtistDetail" }
                    }
                }
            },
            "400": {
                description: "Missing artist ID",
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
                description: "No artist found for that ID",
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
                    ArtistDetail: {
                        type: "object",
                        required: ["id", "name", "image", "bio", "listeners", "albums"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz artist ID" },
                            name: { type: "string" },
                            image: { type: "string", nullable: true, description: "From Last.fm, often null - Last.fm stopped serving real per-artist photos years ago" },
                            bio: { type: "string", nullable: true, description: "From Last.fm" },
                            listeners: { type: "number", nullable: true, description: "Last.fm listener count" },
                            albums: {
                                type: "array",
                                items: { $ref: "#/components/schemas/MediaInfo" }
                            }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const aid = getRouterParam(event, "aid");
    if (!aid) {
        throw createError({ statusCode: 400, statusMessage: "Missing artist ID" });
    }

    const client = getMusicBrainzClient();

    const artist = await client.lookup("artist", aid).catch(() => null);
    if (!artist) {
        throw createError({ statusCode: 404, statusMessage: "No artist found for that ID" });
    }

    const [browsed, lastfm] = await Promise.all([
        client.browse("release-group", { artist: aid }, ["artist-credits"]).catch(() => ({ "release-groups": [] as IReleaseGroup[] })),
        getLastfmArtistInfo(artist.name, aid)
    ]);

    // one MediaInfo per release-group, newest first; secondary types (live/compilation/remix/...) are left
    // in rather than filtered out, same breadth as what a search result for this artist would already show
    const releaseGroups = [...browsed["release-groups"]]
        .sort((a, b) => (b["first-release-date"] ?? "").localeCompare(a["first-release-date"] ?? ""));

    const albums: MediaInfo[] = await Promise.all(releaseGroups.map(async (rg): Promise<MediaInfo> => {
        const primaryType = rg["primary-type"]?.toLowerCase();
        const type = primaryType === "album" || primaryType === "ep" ? primaryType : null;

        return {
            id: rg.id,
            title: rg.title,
            artist: artist.name,
            album: { id: rg.id, type, title: rg.title },
            type,
            coverArt: `https://coverartarchive.org/release-group/${rg.id}/front-250`,
            releaseDate: parseReleaseDate(rg["first-release-date"]),
            inLibrary: await userOwnsAlbum(userId, rg.id),
            duration: 0,
            label: null
        };
    }));

    const detail: ArtistDetail = {
        id: artist.id,
        name: artist.name,
        image: lastfm?.image ?? null,
        bio: lastfm?.bio ?? null,
        listeners: lastfm?.listeners ?? null,
        albums
    };

    return detail;
});
