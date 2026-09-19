import { setAppearanceSettings } from "~~/server/core/appearanceSettings";
import { getPermissionsById } from "~~/server/core/users";

defineRouteMeta({
    openAPI: {
        description: "Update the requesting user's display preferences. Attempting to turn showFileSize on without MANAGE_MUSIC/ADMIN is silently ignored, not rejected.",
        tags: ["user"],
        operationId: "updateAppearanceSettings",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            showFileSize: { type: "boolean" },
                            showDuration: { type: "boolean" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/AppearanceSettings" } } } },
            "400": { description: "No changes provided", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const body = await readBody(event);

    const showFileSize = typeof body?.showFileSize === "boolean" ? body.showFileSize : undefined;
    const showDuration = typeof body?.showDuration === "boolean" ? body.showDuration : undefined;

    if (showFileSize === undefined && showDuration === undefined) {
        throw createError({ statusCode: 400, statusMessage: "No changes provided" });
    }

    const permissions = await getPermissionsById(userId) ?? 0;
    return await setAppearanceSettings(userId, permissions, { showFileSize, showDuration });
});
