import { listApiTokensForUser } from "~~/server/core/apiTokens";

defineRouteMeta({
    openAPI: {
        description: "List the currently authenticated user's own API tokens (app passwords, currently used for Subsonic auth). The token value itself is never returned here - only at creation time",
        tags: ["user"],
        operationId: "getMyApiTokens",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/ApiTokenSummary" }
                        }
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
        },
        $global: {
            components: {
                schemas: {
                    ApiTokenSummary: {
                        type: "object",
                        required: ["id", "userId", "name", "createdAt", "lastUsedAt"],
                        properties: {
                            id: { type: "string" },
                            userId: { type: "string" },
                            name: { type: "string", nullable: true },
                            createdAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            lastUsedAt: { type: "number", nullable: true, description: "Unix timestamp (milliseconds)" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    return await listApiTokensForUser(userId);
});
