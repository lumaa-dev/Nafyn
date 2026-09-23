import { parsePagination, paginated, paginationQueryParams } from "~~/server/utils/pagination";
import { countTransferItems, listTransferItems, type TransferItemFilter } from "~~/server/core/transfer";
import { requireOwnedTransferJob } from "~~/server/utils/transfer/access";

const FILTERS: TransferItemFilter[] = ["all", "failed", "completed", "remaining"];

defineRouteMeta({
    openAPI: {
        description: "The items of one library import, in source order, optionally filtered (`failed` lists every item that couldn't be imported, with its reason)",
        tags: ["transfer"],
        operationId: "getTransferJobItems",
        parameters: [
            { name: "id", in: "path", required: true, description: "Import ID", schema: { type: "string" } },
            { name: "filter", in: "query", required: false, schema: { type: "string", enum: FILTERS, default: "all" } },
            ...paginationQueryParams
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No import with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const job = await requireOwnedTransferJob(event, userId);

    const rawFilter = getQuery(event).filter;
    const filter = FILTERS.includes(rawFilter as TransferItemFilter) ? rawFilter as TransferItemFilter : "all";
    const pagination = parsePagination(event);

    const [items, total] = await Promise.all([
        listTransferItems(job.id, filter, pagination.limit, pagination.offset),
        countTransferItems(job.id, filter)
    ]);
    return paginated(items, total, pagination);
});
