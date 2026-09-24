import { getPlaybackSettings, CROSSFADE_MIN_MS, CROSSFADE_MAX_MS } from "~~/server/core/playbackSettings";

defineRouteMeta({
    openAPI: {
        description: "The requesting user's playback preferences (crossfade). Always scoped to the caller.",
        tags: ["user"],
        operationId: "getPlaybackSettings",
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { $ref: "#/components/schemas/PlaybackSettings" } } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    PlaybackSettings: {
                        type: "object",
                        required: ["crossfadeEnabled", "crossfadeMs"],
                        properties: {
                            crossfadeEnabled: { type: "boolean", description: "Defaults to true" },
                            crossfadeMs: { type: "integer", minimum: CROSSFADE_MIN_MS, maximum: CROSSFADE_MAX_MS, description: "Crossfade length in milliseconds, defaults to 3000" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    return await getPlaybackSettings(userId);
});
