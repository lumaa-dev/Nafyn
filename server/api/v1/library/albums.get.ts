import { getAlbumsOfUser, countAlbumsOfUser } from "~~/server/core/library";
import { parsePagination, paginated, paginationQueryParams, paginatedResponseSchema } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List every album the requesting user owns at least one track from, aggregated from their library, paginated",
        tags: ["library"],
        operationId: "getLibraryAlbums",
        parameters: paginationQueryParams,
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: paginatedResponseSchema("#/components/schemas/AlbumRow")
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
                        required: ["id", "mbId", "title", "artistName", "artistMbid", "coverArt", "releaseDate", "duration", "trackCount", "addedAt"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz release-group ID" },
                            mbId: { type: "string", description: "MusicBrainz recording ID of one of the album's owned tracks" },
                            title: { type: "string" },
                            artistName: { type: "string" },
                            artistMbid: { type: "string", nullable: true },
                            coverArt: { type: "string", nullable: true },
                            releaseDate: { type: "number", nullable: true, description: "Unix timestamp (seconds)" },
                            duration: { type: "number", description: "Combined seconds of all owned tracks from this album" },
                            trackCount: { type: "number", description: "Number of owned tracks from this album" },
                            addedAt: { type: "number", description: "Unix timestamp (milliseconds) the earliest owned track from this album was added" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);
  const pagination = parsePagination(event);

  const [items, total] = await Promise.all([
    getAlbumsOfUser(userId, pagination.limit, pagination.offset),
    countAlbumsOfUser(userId)
  ]);
  return paginated(items, total, pagination);
})
