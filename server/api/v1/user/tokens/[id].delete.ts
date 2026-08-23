import { deleteApiToken } from "~~/server/core/apiTokens";

defineRouteMeta({
    openAPI: {
        description: "Revoke one of the currently authenticated user's own API tokens",
        tags: ["user"],
        operationId: "deleteMyApiToken",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "API token ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: ""
            },
            "400": {
                description: "Missing token ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
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
            },
            "404": {
                description: "No token with that ID owned by the requesting user",
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

    const id = getRouterParam(event, "id");
    if (!id) {
        throw createError({ statusCode: 400, statusMessage: "Missing token ID" });
    }

    const removed = await deleteApiToken(userId, id);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "No token with that ID" });
    }

    return { removed: true };
});
