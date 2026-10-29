import { listImports } from "~~/server/core/imports";
import { paginated, paginatedResponseSchema, paginationQueryParams, parsePagination } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "The caller's playlist imports, newest first, without their tracks (GET /api/v1/import/{id} has those). Finished imports are kept 30 days",
        tags: ["import"],
        operationId: "listImports",
        parameters: paginationQueryParams,
        responses: {
            "200": { description: "", content: { "application/json": { schema: paginatedResponseSchema("#/components/schemas/PlaylistImport") } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const pagination = parsePagination(event);
    const { items, total } = await listImports(userId, pagination.limit, pagination.offset);
    return paginated(items, total, pagination);
});
