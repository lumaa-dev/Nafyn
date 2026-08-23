import { listRequests, listRequestsByUser, countRequests, countRequestsByUser } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { parsePagination, paginated, paginationQueryParams, paginatedResponseSchema } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List download requests, paginated. Users with MANAGE_REQUESTS get every request across every user; others get only their own",
        tags: ["request"],
        operationId: "getRequests",
        parameters: paginationQueryParams,
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

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);
  const pagination = parsePagination(event);

  if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS)) {
    const [items, total] = await Promise.all([
      listRequestsByUser(userId, pagination.limit, pagination.offset),
      countRequestsByUser(userId)
    ]);
    return paginated(items, total, pagination);
  }

  const [items, total] = await Promise.all([
    listRequests(pagination.limit, pagination.offset),
    countRequests()
  ]);
  return paginated(items, total, pagination);
})
