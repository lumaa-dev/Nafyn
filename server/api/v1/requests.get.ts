import { listRequests, countRequests, REQUEST_STATUS_GROUPS, type RequestListFilter, type RequestStatusGroup } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { parsePagination, paginated, paginationQueryParams, paginatedResponseSchema } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List download requests, paginated. Users with MANAGE_REQUESTS get every request across every user (narrowed to one account with `user`); others get only their own",
        tags: ["request"],
        operationId: "getRequests",
        // typed loosely like the shared pagination fragments (their string literals widen, which Nitro's
        // OpenAPI typing rejects at the type level only - the generated spec is unaffected)
        parameters: [
            ...paginationQueryParams,
            { name: "succeeded", in: "query", required: false, description: "Include completed requests; `false` leaves them out. Defaults to true", schema: { type: "boolean", default: true } },
            { name: "failed", in: "query", required: false, description: "Include failed requests; `false` leaves them out. Defaults to true", schema: { type: "boolean", default: true } },
            { name: "waiting", in: "query", required: false, description: "Include requests waiting for a manager to accept them; `false` leaves them out. Defaults to true", schema: { type: "boolean", default: true } },
            { name: "processing", in: "query", required: false, description: "Include requests being worked on (searching, downloading, processing); `false` leaves them out. Defaults to true", schema: { type: "boolean", default: true } },
            { name: "type", in: "query", required: false, description: "Only album requests (`album`) or only track requests (`track`). Any other value, or none, lists both", schema: { type: "string", enum: ["album", "track"] } },
            { name: "user", in: "query", required: false, description: "Only the requests of this account (user id). For a user without MANAGE_REQUESTS any id but their own lists nothing", schema: { type: "string" } }
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

// `type=album|track`; anything else is no type filter
function parseType(event: Parameters<typeof getQuery>[0]): RequestListFilter["type"] {
  const value = String(getQuery(event).type ?? "").toLowerCase();
  return value === "album" || value === "track" ? value : undefined;
}

// `user=<id>`, trimmed; empty is no user filter
function parseUser(event: Parameters<typeof getQuery>[0]): string | undefined {
  const value = getQuery(event).user;
  const id = typeof value === "string" ? value.trim() : "";
  return id.length > 0 && id.length <= 64 ? id : undefined;
}

export default defineEventHandler(async (event) => {
  const { sub: userId } = await requireAuthToken(event);
  const pagination = parsePagination(event);
  const filter: RequestListFilter = { excluded: parseExcludedGroups(event), type: parseType(event), requestedBy: parseUser(event) };

  if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS)) {
    // only ever their own: another account's id narrows that down to nothing
    if (filter.requestedBy !== undefined && filter.requestedBy !== userId) return paginated([], 0, pagination);
    filter.requestedBy = userId;
  }

  const [items, total] = await Promise.all([
    listRequests(filter, pagination.limit, pagination.offset),
    countRequests(filter)
  ]);
  return paginated(items, total, pagination);
})
