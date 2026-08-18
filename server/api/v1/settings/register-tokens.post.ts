import { createRegisterToken } from "~~/server/core/registerTokens";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "Create a one-time, 4-hour-lived registration token that unlocks /register when open registration is disabled. Requires MANAGE_ACCOUNTS",
        tags: ["settings"],
        operationId: "createRegisterToken",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/RegisterTokenRow" }
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
        },
        $global: {
            components: {
                schemas: {
                    RegisterTokenRow: {
                        type: "object",
                        required: ["id", "token", "createdBy", "createdAt", "expiresAt", "usedAt"],
                        properties: {
                            id: { type: "string" },
                            token: { type: "string" },
                            createdBy: { type: "string", description: "User ID who created the token" },
                            createdAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            expiresAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            usedAt: { type: "number", nullable: true, description: "Unix timestamp (milliseconds), if the token has been consumed" }
                        }
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

    return await createRegisterToken(userId);
});
