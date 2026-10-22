import { listRequests, listRequestsByUser, countRequests, countRequestsByUser, REQUEST_STATUS_GROUPS, type RequestStatusGroup } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { parsePagination, paginated, paginationQueryParams, paginatedResponseSchema } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List download requests, paginated. Users with MANAGE_REQUESTS get every request across every user; others get only their own",
        tags: ["request"],
        operationId: "getRequests",
        // typed loosely like the shared pagination fragments (their string literals widen, which Nitro's
        // OpenAPI typing rejects at the type level only - the generated spec is unaffected)
        parameters: [
            ...paginationQueryParams,
            { name: "succeeded", in: "query", required: false, description: "Include completed requests; `false` leaves them out. Defaults to true", schema: { type: "boolean", default: true } },
            { name: "failed", in: "query", required: false, description: "Include failed requests; `false` leaves them out. Defaults to true", schema: { type: "boolean", default: true } },
            { name: "waiting", in: "query", required: false, description: "Include requests waiting for a manager to accept them; `false` leaves them out. Defaults to true", schema: { type: "boolean", default: true } },
            { name: "processing", in: "query", required: false, description: "Include requests being worked on (searching, downloading, processing); `false` leaves them out. Defaults to true", schema: { type: "boolean", default: true } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: paginatedResponseSchema("#/components/schemas/NafynRequest")
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
        }
    },
});

// every group is included unless its query parameter is explicitly `false` (or `0`)
function parseExcludedGroups(event: Parameters<typeof getQuery>[0]): RequestStatusGroup[] {
  const query = getQuery(event);
  return (Object.keys(REQUEST_STATUS_GROUPS) as RequestStatusGroup[]).filter((group) => {
    const value = String(query[group] ?? "").toLowerCase();
    return value === "false" || value === "0";
  });
}

export default defineEventHandler(async (event) => {
  const { sub: userId } = await requireAuthToken(event);
  const pagination = parsePagination(event);
  const excluded = parseExcludedGroups(event);

  if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS)) {
    const [items, total] = await Promise.all([
      listRequestsByUser(userId, pagination.limit, pagination.offset, excluded),
      countRequestsByUser(userId, excluded)
    ]);
    return paginated(items, total, pagination);
  }

  const [items, total] = await Promise.all([
    listRequests(pagination.limit, pagination.offset, excluded),
    countRequests(excluded)
  ]);
  return paginated(items, total, pagination);
})
