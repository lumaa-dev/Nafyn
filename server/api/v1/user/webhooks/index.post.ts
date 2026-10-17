import { createWebhook, rethrowWebhookError } from "~~/server/utils/webhook";

defineRouteMeta({
    openAPI: {
        description: "Add a webhook to the currently authenticated user's own webhooks. The URL is checked (https, public address) before it is stored, and its service (Discord, Slack, ntfy, Gotify, generic JSON) is auto-detected unless `format` says otherwise",
        tags: ["user"],
        operationId: "createMyWebhook",
        requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookInput" } } }
        },
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookSummary" } } }
            },
            "400": { description: "Invalid name, URL, format or events", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "Webhook limit reached", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const body = await readBody(event).catch(() => null);
    if (!body || typeof body !== "object") {
        throw createError({ statusCode: 400, statusMessage: "Malformed request" });
    }

    return await createWebhook(userId, body).catch(rethrowWebhookError);
});
