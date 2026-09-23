import { transferProviderStatuses } from "~~/server/utils/transfer/providers";

defineRouteMeta({
    openAPI: {
        description: "List the streaming services a library can be imported from, and whether this server has the developer credentials each one needs",
        tags: ["transfer"],
        operationId: "getTransferProviders",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: {
                                type: "object",
                                required: ["id", "configured", "authModes"],
                                properties: {
                                    id: { type: "string", enum: ["spotify", "apple", "deezer", "soundcloud", "youtube", "tidal", "amazon", "napster"] },
                                    configured: { type: "boolean" },
                                    authModes: { type: "array", items: { type: "string", enum: ["oauth", "musickit", "profile"] } }
                                }
                            }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler((event) => {
    requireAuthToken(event);
    return transferProviderStatuses();
});
