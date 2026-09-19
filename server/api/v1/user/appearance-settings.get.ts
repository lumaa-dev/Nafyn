import { getAppearanceSettings } from "~~/server/core/appearanceSettings";
import { getPermissionsById } from "~~/server/core/users";

defineRouteMeta({
    openAPI: {
        description: "The requesting user's display preferences (file size / duration visibility in track lists). Always scoped to the caller.",
        tags: ["user"],
        operationId: "getAppearanceSettings",
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { $ref: "#/components/schemas/AppearanceSettings" } } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    AppearanceSettings: {
                        type: "object",
                        required: ["showFileSize", "showDuration"],
                        properties: {
                            showFileSize: { type: "boolean", description: "Locked to false for users without MANAGE_MUSIC/ADMIN, regardless of what's stored" },
                            showDuration: { type: "boolean" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const permissions = await getPermissionsById(userId) ?? 0;
    return await getAppearanceSettings(userId, permissions);
});
