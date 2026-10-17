import { deleteWebhook } from "~~/server/utils/webhook";

defineRouteMeta({
    openAPI: {
        description: "Delete one of the currently authenticated user's own webhooks",
        tags: ["user"],
        operationId: "deleteMyWebhook",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
            "200": { description: "" },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No webhook with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const id = getRouterParam(event, "id");
    if (!id) {
        throw createError({ statusCode: 400, statusMessage: "Missing webhook ID" });
    }

    if (!await deleteWebhook(userId, id)) {
        throw createError({ statusCode: 404, statusMessage: "No webhook with that ID" });
    }
    return { removed: true };
});
