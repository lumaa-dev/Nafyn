import { parsePagination, paginated, paginationQueryParams } from "~~/server/utils/pagination";
import { countTransferJobs, listTransferJobs } from "~~/server/core/transfer";

defineRouteMeta({
    openAPI: {
        description: "List the requesting user's library imports, newest first",
        tags: ["transfer"],
        operationId: "getTransferJobs",
        parameters: paginationQueryParams,
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const pagination = parsePagination(event, 20);
    const [items, total] = await Promise.all([
        listTransferJobs(userId, pagination.limit, pagination.offset),
        countTransferJobs(userId)
    ]);
    return paginated(items, total, pagination);
});
