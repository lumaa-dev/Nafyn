import { setUnitySettings } from "~~/server/core/unitySettings";
import { disableUnityForUser } from "~~/server/utils/unityRegistry";

defineRouteMeta({
    openAPI: {
        description: "Turn Nafyn Unity on or off account-wide for the requesting user.",
        tags: ["user"],
        operationId: "updateUnitySettings",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["enabled"],
                        properties: {
                            enabled: { type: "boolean" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/UnitySettings" } } } },
            "400": { description: "Missing `enabled`", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const body = await readBody(event);

    if (typeof body?.enabled !== "boolean") {
        throw createError({ statusCode: 400, statusMessage: "Missing `enabled`" });
    }

    const settings = await setUnitySettings(userId, body.enabled);
    // switching it off ends the live session now: every device is disconnected and the Now Playing status the
    // Apple devices were following goes with it
    if (!settings.enabled) disableUnityForUser(userId);
    return settings;
});
