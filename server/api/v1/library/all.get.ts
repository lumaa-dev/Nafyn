// every media row across every user's library, view-only for MANAGE_MUSIC users (streaming still enforces per-owner access)
import { getAllMediaWithOwners, countAllMedia } from "~~/server/core/library";
import { listUsers, getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { parsePagination, paginated, paginationQueryParams } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List every media row across every user's library, with owner usernames, paginated. Requires MANAGE_MUSIC",
        tags: ["library"],
        operationId: "getAllLibraryMedia",
        parameters: paginationQueryParams,
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["items", "page", "limit", "total", "hasMore"],
                            properties: {
                                items: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        allOf: [
                                            { $ref: "#/components/schemas/MediaRow" },
                                            {
                                                type: "object",
                                                required: ["owners"],
                                                properties: {
                                                    owners: {
                                                        type: "array",
                                                        items: {
                                                            type: "object",
                                                            required: ["userId", "username"],
                                                            properties: {
                                                                userId: { type: "string" },
                                                                username: { type: "string" }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        ]
                                    }
                                },
                                page: { type: "integer" },
                                limit: { type: "integer" },
                                total: { type: "integer" },
                                hasMore: { type: "boolean" }
                            }
                        }
                    }
                }
            },
            "401": {
                description: "Not authenticated, or missing MANAGE_MUSIC permission",
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

    if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_MUSIC)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const pagination = parsePagination(event);
    const [media, total, allUsers] = await Promise.all([
        getAllMediaWithOwners(pagination.limit, pagination.offset),
        countAllMedia(),
        listUsers()
    ]);
    const usersById = new Map(allUsers.map((u) => [u.id, u]));

    const items = media.map(({ ownerIds, ...row }) => ({
        ...row,
        owners: ownerIds.map((id) => ({ userId: id, username: usersById.get(id)?.username ?? "unknown" }))
    }));

    return paginated(items, total, pagination);
});
