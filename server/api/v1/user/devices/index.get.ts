import { listDevices } from "~~/server/utils/apn";

defineRouteMeta({
    openAPI: {
        description: "List the Apple devices registered by the Nafyn iOS app for the currently authenticated user - one entry per device, however many push tokens (notifications, Live Activities, Now Playing) it registered. Tokens themselves are never returned",
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
                        required: ["id", "deviceName", "environment", "kinds", "events", "currentSession", "createdAt", "lastSeenAt"],
                        properties: {
                            id: { type: "string", description: "The device's id (its login's session id); what DELETE /api/v1/user/devices/{id} takes" },
                            deviceName: { type: "string", nullable: true },
                            environment: { type: "string", enum: ["sandbox", "production"] },
                            kinds: { type: "array", items: { type: "string", enum: ["alert", "la-start:request", "la-start:release", "nowplaying-start"] }, description: "Push features this device registered a token for" },
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
