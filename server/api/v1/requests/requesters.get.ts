import { listRequesters } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "The accounts that made at least one listed request (id, username, display name, avatar), sorted by name: the choices of the requests list's `user` filter. Needs MANAGE_REQUESTS",
        tags: ["request"],
        operationId: "getRequesters",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    username: { type: "string" },
                                    displayName: { type: ["string", "null"] },
                                    avatar: { type: ["string", "null"] }
                                },
                                required: ["id", "username", "displayName", "avatar"]
                            }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "Missing MANAGE_REQUESTS", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
  const { sub: userId } = await requireAuthToken(event);
  if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS)) {
    throw createError({ statusCode: 403, statusMessage: "Missing permission" });
  }
  const users = await listRequesters();
  return users.map((user) => ({ id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar }));
})
