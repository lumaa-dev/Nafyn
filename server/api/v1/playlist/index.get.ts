import { getPlaylistsForUser, countPlaylistsForUser } from "~~/server/core/playlists";
import { parsePagination, paginated, paginationQueryParams, paginatedResponseSchema } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List playlists owned by, or shared with, the requesting user, paginated",
        tags: ["playlist"],
        operationId: "getPlaylists",
        parameters: paginationQueryParams,
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: paginatedResponseSchema("#/components/schemas/PlaylistRow")
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
                    PlaylistRow: {
                        type: "object",
                        required: ["id", "ownerId", "title", "description", "privacy", "image", "sortMode", "createdAt", "updatedAt"],
                        properties: {
                            id: { type: "string" },
                            ownerId: { type: "string" },
                            title: { type: "string" },
                            description: { type: "string", nullable: true },
                            privacy: { type: "string", enum: ["public", "private"] },
                            image: { type: "string", nullable: true, description: "Cache-busting version stamp; the actual image is served from GET /playlist/{pid}/image" },
                            sortMode: { type: "string", enum: ["manual", "title", "artist", "addedBy", "duration"] },
                            createdAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            updatedAt: { type: "number", description: "Unix timestamp (milliseconds)" }
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
        getPlaylistsForUser(userId, pagination.limit, pagination.offset),
        countPlaylistsForUser(userId)
    ]);
    return paginated(items, total, pagination);
});
