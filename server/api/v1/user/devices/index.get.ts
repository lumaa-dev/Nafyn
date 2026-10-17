import { listDevices } from "~~/server/utils/apn";

defineRouteMeta({
    openAPI: {
        description: "List the Apple devices (APNs tokens) registered by the Nafyn iOS app for the currently authenticated user. Tokens themselves are never returned",
        tags: ["user"],
        operationId: "listMyAppleDevices",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { type: "array", items: { $ref: "#/components/schemas/AppleDevice" } }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    AppleDevice: {
                        type: "object",
                        required: ["id", "kind", "environment", "deviceName", "events", "currentSession", "createdAt", "lastSeenAt"],
                        properties: {
                            id: { type: "string" },
                            kind: { type: "string", enum: ["alert", "la-start:request", "la-start:release", "nowplaying-start"] },
                            environment: { type: "string", enum: ["sandbox", "production"] },
                            deviceName: { type: "string", nullable: true },
                            events: { type: "array", nullable: true, items: { type: "string" }, description: "null = every event" },
                            currentSession: { type: "boolean", description: "Registered by the login making this request" },
                            createdAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            lastSeenAt: { type: "number", description: "Unix timestamp (milliseconds)" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId, jti } = await requireAuthToken(event);
    return await listDevices(userId, jti);
});
