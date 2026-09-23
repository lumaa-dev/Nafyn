import { setPlaybackSettings } from "~~/server/core/playbackSettings";

defineRouteMeta({
    openAPI: {
        description: "Update the requesting user's playback preferences. crossfadeMs is clamped to 500-12000.",
        tags: ["user"],
        operationId: "updatePlaybackSettings",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            crossfadeEnabled: { type: "boolean" },
                            crossfadeMs: { type: "integer" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/PlaybackSettings" } } } },
            "400": { description: "No changes provided", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const body = await readBody(event);

    const crossfadeEnabled = typeof body?.crossfadeEnabled === "boolean" ? body.crossfadeEnabled : undefined;
    const crossfadeMs = typeof body?.crossfadeMs === "number" && Number.isFinite(body.crossfadeMs) ? body.crossfadeMs : undefined;

    if (crossfadeEnabled === undefined && crossfadeMs === undefined) {
        throw createError({ statusCode: 400, statusMessage: "No changes provided" });
    }

    return await setPlaybackSettings(userId, { crossfadeEnabled, crossfadeMs });
});
