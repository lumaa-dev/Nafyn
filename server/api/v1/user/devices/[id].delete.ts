import { deleteDevice } from "~~/server/utils/apn";

defineRouteMeta({
    openAPI: {
        description: "Unregister one of the currently authenticated user's Apple device tokens - that device stops receiving pushes of that kind until the app registers again",
        tags: ["user"],
        operationId: "deleteMyAppleDevice",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
            "200": { description: "" },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No device with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const id = getRouterParam(event, "id");
    if (!id) {
        throw createError({ statusCode: 400, statusMessage: "Missing device ID" });
    }

    if (!await deleteDevice(userId, id)) {
        throw createError({ statusCode: 404, statusMessage: "No device with that ID" });
    }
    return { removed: true };
});
