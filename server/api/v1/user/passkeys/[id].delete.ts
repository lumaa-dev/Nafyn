import { deletePasskey } from "~~/server/core/passkeys";

defineRouteMeta({
    openAPI: {
        description: "Remove one of the currently authenticated user's own passkeys",
        tags: ["user"],
        operationId: "deleteMyPasskey",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Passkey ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": { description: "" },
            "400": {
                description: "Missing passkey ID",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "401": {
                description: "Not authenticated",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "404": {
                description: "No passkey with that ID owned by the requesting user",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const id = getRouterParam(event, "id");
    if (!id) {
        throw createError({ statusCode: 400, statusMessage: "Missing passkey ID" });
    }

    const removed = await deletePasskey(userId, id);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "No passkey with that ID" });
    }

    return { removed: true };
});
