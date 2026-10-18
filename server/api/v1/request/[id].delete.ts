import { deleteRequestIfIdle } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "Delete a download request. Requires MANAGE_REQUESTS. A request the download pipeline is working on (searching, downloading, processing) can't be deleted by anyone, ADMIN included - wait for it to finish or fail. Waiting, completed, failed and denied requests can. Deleting a request never removes anything from a library",
        tags: ["request"],
        operationId: "deleteRequest",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Request ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": { description: "" },
            "400": {
                description: "Missing request ID",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "401": {
                description: "Not authenticated",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "403": {
                description: "Missing MANAGE_REQUESTS permission",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "404": {
                description: "No request with that ID",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            },
            "409": {
                description: "The request is being processed right now and can't be deleted",
                content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS)) {
        throw createError({ statusCode: 403, statusMessage: "Unsufficient permissions" });
    }

    const id = getRouterParam(event, "id");
    if (!id) {
        throw createError({ statusCode: 400, statusMessage: "Missing request ID" });
    }

    const outcome = await deleteRequestIfIdle(id);
    if (outcome === "missing") {
        throw createError({ statusCode: 404, statusMessage: "No request with that ID" });
    }
    if (outcome === "active") {
        throw createError({ statusCode: 409, statusMessage: "This request is being processed and can't be deleted" });
    }

    return { removed: true };
});
