import { getAlbumsOfUser } from "~~/server/core/library";

defineRouteMeta({
    openAPI: {
        description: "List every album the requesting user owns at least one track from, aggregated from their library",
        tags: ["library"],
        operationId: "getLibraryAlbums",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/AlbumRow" }
                        }
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
                    AlbumRow: {
                        type: "object",
                        required: ["id", "mbId", "title", "artistName", "artistMbid", "coverArt", "releaseDate", "duration", "trackCount"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz release-group ID" },
                            mbId: { type: "string", description: "MusicBrainz recording ID of one of the album's owned tracks" },
                            title: { type: "string" },
                            artistName: { type: "string" },
                            artistMbid: { type: "string", nullable: true },
                            coverArt: { type: "string", nullable: true },
                            releaseDate: { type: "number", nullable: true, description: "Unix timestamp (seconds)" },
                            duration: { type: "number", description: "Combined seconds of all owned tracks from this album" },
                            trackCount: { type: "number", description: "Number of owned tracks from this album" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);

  return await getAlbumsOfUser(userId);
})
