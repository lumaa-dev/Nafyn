import { createPlaylist } from "~~/server/core/playlists";

defineRouteMeta({
    openAPI: {
        description: "Create a new playlist owned by the requesting user",
        tags: ["playlist"],
        operationId: "createPlaylist",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["title"],
                        properties: {
                            title: { type: "string", description: "1-100 characters" },
                            description: { type: "string" },
                            privacy: { type: "string", enum: ["public", "private"], description: "Defaults to \"private\"" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/PlaylistRow" }
                    }
                }
            },
            "400": {
                description: "Title must be between 1 and 100 characters",
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
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const body = await readBody(event);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    const privacy = body?.privacy === "public" ? "public" : "private";

    if (title.length < 1 || title.length > 100) {
        throw createError({ statusCode: 400, statusMessage: "Title must be between 1 and 100 characters" });
    }

    return await createPlaylist(userId, title, description || null, privacy);
});
