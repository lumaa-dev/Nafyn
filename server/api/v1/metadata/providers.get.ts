import { listMetadataProviders } from "../../../utils/metadata";
import { requireAuthToken } from "../../../utils/requireAuth";

defineRouteMeta({
    openAPI: {
        description: "List the song metadata providers and whether each one is enabled on this server (keyed providers are disabled when their key isn't configured)",
        tags: ["search"],
        operationId: "getMetadataProviders",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string" },
                                    name: { type: "string" },
                                    enabled: { type: "boolean" },
                                    search: { type: "boolean", description: "Answers text searches" },
                                    isrc: { type: "boolean", description: "Answers ISRC lookups" },
                                    idLookup: { type: "boolean", description: "Answers platform ID lookups" }
                                }
                            }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler((event) => {
    requireAuthToken(event);
    return listMetadataProviders();
});
