import { revokeSession } from "~~/server/core/sessions";
import { markSessionRevoked } from "~~/server/utils/sessionCache";
import { closeUnityConnectionsForSession } from "~~/server/utils/unityRegistry";

defineRouteMeta({
    openAPI: {
        description: "Revoke one of the currently authenticated user's own login sessions, signing that device out immediately",
        tags: ["user"],
        operationId: "deleteMySession",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Session ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: ""
            },
            "400": {
                description: "Missing session ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "No session with that ID owned by the requesting user",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const id = getRouterParam(event, "id");
    if (!id) {
        throw createError({ statusCode: 400, statusMessage: "Missing session ID" });
    }

    const removed = await revokeSession(userId, id);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "No session with that ID" });
    }

    markSessionRevoked(id);
    closeUnityConnectionsForSession(userId, id);

    return { removed: true };
});
