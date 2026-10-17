import { rethrowWebhookError, updateWebhook } from "~~/server/utils/webhook";

defineRouteMeta({
    openAPI: {
        description: "Edit one of the instance's global webhooks. Requires MANAGE_WEBHOOKS. Every field is optional; re-enabling a webhook that was switched off after repeated failures clears its failure count",
        tags: ["settings"],
        operationId: "updateGlobalWebhook",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
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
            "403": { description: "Missing MANAGE_WEBHOOKS", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No webhook with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    await requireWebhookManager(event);

    const id = getRouterParam(event, "id");
    const body = await readBody(event).catch(() => null);
    if (!id || !body || typeof body !== "object") {
        throw createError({ statusCode: 400, statusMessage: "Malformed request" });
    }

    const updated = await updateWebhook(null, id, body).catch(rethrowWebhookError);
    if (!updated) {
        throw createError({ statusCode: 404, statusMessage: "No webhook with that ID" });
    }
    return updated;
});
