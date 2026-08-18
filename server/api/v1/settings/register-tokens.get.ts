import { listActiveRegisterTokens } from "~~/server/core/registerTokens";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "List active (unused, unexpired) registration tokens. Requires MANAGE_ACCOUNTS",
        tags: ["settings"],
        operationId: "getRegisterTokens",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/RegisterTokenRow" }
                        }
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

    return await listActiveRegisterTokens();
});
