import { getUnitySettings } from "~~/server/core/unitySettings";

defineRouteMeta({
    openAPI: {
        description: "The requesting user's Nafyn Unity preference. Always scoped to the caller.",
        tags: ["user"],
        operationId: "getUnitySettings",
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { $ref: "#/components/schemas/UnitySettings" } } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    UnitySettings: {
                        type: "object",
                        required: ["enabled"],
                        properties: {
                            enabled: { type: "boolean", description: "Defaults to true" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    return await getUnitySettings(userId);
});
