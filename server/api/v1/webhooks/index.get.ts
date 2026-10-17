import { listGlobalWebhooks } from "~~/server/utils/webhook";

defineRouteMeta({
    openAPI: {
        description: "List the instance's global webhooks. Requires MANAGE_WEBHOOKS. Webhook URLs are never returned, only their host",
        tags: ["settings"],
        operationId: "listGlobalWebhooks",
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/WebhookSummary" } } } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "Missing MANAGE_WEBHOOKS", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    await requireWebhookManager(event);

    return await listGlobalWebhooks();
});
