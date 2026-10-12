import { listPasskeysForUser } from "~~/server/core/passkeys";

defineRouteMeta({
    openAPI: {
        description: "List the currently authenticated user's own registered passkeys. Public keys are never returned.",
        tags: ["user"],
        operationId: "getMyPasskeys",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/PasskeySummary" }
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
                    PasskeySummary: {
                        type: "object",
                        required: ["id", "userId", "label", "createdAt", "lastUsedAt"],
                        properties: {
                            id: { type: "string" },
                            userId: { type: "string" },
                            label: { type: "string", nullable: true },
                            deviceType: { type: "string" },
                            backedUp: { type: "boolean" },
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
    const { sub: userId } = await requireAuthToken(event);
    return await listPasskeysForUser(userId);
});
