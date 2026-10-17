import { countSubscriptions, listSubscriptions } from "~~/server/core/releaseSubscriptions";
import { paginated, paginatedResponseSchema, paginationQueryParams, parsePagination } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List the unreleased albums/tracks the currently authenticated user follows, upcoming first. Delivered ones stay listed (with `notifiedAt` set) for 30 days",
        tags: ["subscriptions"],
        operationId: "listReleaseSubscriptions",
        parameters: paginationQueryParams,
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: paginatedResponseSchema("#/components/schemas/ReleaseSubscription") } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    ReleaseSubscription: {
                        type: "object",
                        required: ["id", "musicbrainzId", "type", "title", "artistName", "coverArt", "releaseDate", "timezone", "releaseAt", "notifiedAt", "createdAt"],
                        properties: {
                            id: { type: "string" },
                            musicbrainzId: { type: "string" },
                            type: { type: "string", enum: ["album", "track"] },
                            title: { type: "string", nullable: true },
                            artistName: { type: "string", nullable: true },
                            coverArt: { type: "string", nullable: true },
                            releaseDate: { type: "string", format: "date" },
                            timezone: { type: "string", description: "IANA timezone the release moment is computed in" },
                            releaseAt: { type: "number", description: "Unix timestamp (milliseconds) of local midnight on releaseDate" },
                            notifiedAt: { type: "number", nullable: true },
                            createdAt: { type: "number" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const pagination = parsePagination(event);

    const [items, total] = await Promise.all([
        listSubscriptions(userId, pagination.limit, pagination.offset),
        countSubscriptions(userId)
    ]);
    return paginated(items, total, pagination);
});
