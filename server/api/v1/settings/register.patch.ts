import { setRegistrationOpen } from "~~/server/core/appSettings";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "Open or close public registration. Requires MANAGE_ACCOUNTS",
        tags: ["settings"],
        operationId: "setRegistrationOpen",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["open"],
                        properties: {
                            open: { type: "boolean" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["open"],
                            properties: {
                                open: { type: "boolean" }
                            }
                        }
                    }
                }
            },
            "400": {
                description: "Missing 'open' boolean",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
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

    const body = await readBody(event);
    if (typeof body?.open !== "boolean") {
        throw createError({ statusCode: 400, statusMessage: "Missing 'open' boolean" });
    }

    await setRegistrationOpen(body.open);

    return { open: body.open };
});
