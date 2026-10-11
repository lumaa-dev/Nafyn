import { listSessionsForUser } from "~~/server/core/sessions";
import { labelUserAgent } from "~~/server/utils/userAgent";

defineRouteMeta({
    openAPI: {
        description: "List the currently authenticated user's own active login sessions, one per device/login",
        tags: ["user"],
        operationId: "getMySessions",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/SessionSummary" }
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
                    SessionSummary: {
                        type: "object",
                        required: ["id", "deviceLabel", "createdAt", "lastSeenAt", "isCurrent"],
                        properties: {
                            id: { type: "string" },
                            deviceLabel: { type: "string" },
                            createdAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            lastSeenAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            isCurrent: { type: "boolean" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId, jti } = await requireAuthToken(event);

    const sessions = await listSessionsForUser(userId);
    return sessions.map((s) => ({
        id: s.id,
        deviceLabel: labelUserAgent(s.userAgent),
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        isCurrent: s.id === jti
    }));
});
