import { listUserWebhooks } from "~~/server/utils/webhook";

defineRouteMeta({
    openAPI: {
        description: "List the currently authenticated user's own webhooks. Webhook URLs are never returned, only their host",
        tags: ["user"],
        operationId: "listMyWebhooks",
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/WebhookSummary" } } } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    WebhookSummary: {
                        type: "object",
                        required: ["id", "global", "name", "format", "urlPreview", "events", "enabled", "failureCount", "lastError", "lastDeliveredAt", "createdAt"],
                        properties: {
                            id: { type: "string" },
                            global: { type: "boolean", description: "true for an instance webhook, false for a personal one" },
                            name: { type: "string" },
                            format: { type: "string", enum: ["discord", "slack", "ntfy", "gotify", "json"] },
                            urlPreview: { type: "string", description: "Scheme and host only - the full URL is a secret and is never returned" },
                            events: { type: "array", nullable: true, items: { type: "string", enum: ["request.created", "request.accepted", "request.denied", "request.completed", "request.failed", "release.out"] }, description: "null = every event" },
                            enabled: { type: "boolean" },
                            failureCount: { type: "integer", description: "Consecutive failed deliveries; the webhook is disabled at 10" },
                            lastError: { type: "string", nullable: true },
                            lastDeliveredAt: { type: "number", nullable: true, description: "Unix timestamp (milliseconds)" },
                            createdAt: { type: "number", description: "Unix timestamp (milliseconds)" }
                        }
                    },
                    WebhookInput: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Up to 100 characters" },
                            url: { type: "string", description: "https only. Private/LAN addresses are refused (instance webhooks may allow them with NAFYN_WEBHOOK_ALLOW_PRIVATE=true)" },
                            format: { type: "string", enum: ["auto", "discord", "slack", "ntfy", "gotify", "json"], description: "Defaults to auto-detection from the URL" },
                            events: { type: "array", nullable: true, items: { type: "string" }, description: "null = every event" },
                            enabled: { type: "boolean" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    return await listUserWebhooks(userId);
});
