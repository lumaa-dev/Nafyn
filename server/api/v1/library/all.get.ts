// every media row across every user's library, view-only for MANAGE_MUSIC users (streaming still enforces per-owner access)
import { getAllMediaWithOwners } from "~~/server/core/library";
import { listUsers, getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "List every media row across every user's library, with owner usernames. Requires MANAGE_MUSIC",
        tags: ["library"],
        operationId: "getAllLibraryMedia",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
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

    const users = new Map((await listUsers()).map((u) => [u.id, u]));

    return (await getAllMediaWithOwners()).map(({ ownerIds, ...media }) => ({
        ...media,
        owners: ownerIds.map((id) => ({ userId: id, username: users.get(id)?.username ?? "unknown" }))
    }));
});
