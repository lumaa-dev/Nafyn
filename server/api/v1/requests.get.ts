import { listRequests } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "List every download request across every user. Requires MANAGE_REQUESTS",
        tags: ["request"],
        operationId: "getRequests",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/NafynRequest" }
                        }
                    }
                }
            },
            "401": {
                description: "Not authenticated, or missing MANAGE_REQUESTS permission",
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

  if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS)) {
    throw createError({ statusCode: 401, message: "Unsufficient permissions" });
  }

  return await listRequests()
})
