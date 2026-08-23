import { listUsers, countUsers, getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { parsePagination, paginated, paginationQueryParams, paginatedResponseSchema } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List every user account, paginated. Requires MANAGE_ACCOUNTS",
        tags: ["users"],
        operationId: "getUsers",
        parameters: paginationQueryParams,
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: paginatedResponseSchema("#/components/schemas/NafynUser")
                    }
                }
            },
            "401": {
                description: "Not authenticated, or missing MANAGE_ACCOUNTS permission",
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

    if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_ACCOUNTS)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const pagination = parsePagination(event);
    const [items, total] = await Promise.all([
        listUsers(pagination.limit, pagination.offset),
        countUsers()
    ]);
    return paginated(items, total, pagination);
});
