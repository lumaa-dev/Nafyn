import { deleteLibraryEntryForUser } from "~~/server/core/library";

defineRouteMeta({
    openAPI: {
        description: "Remove a track from the requesting user's own library. If no other user still references the underlying file, it's deleted too",
        tags: ["library"],
        operationId: "removeLibraryTrack",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Media ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["removed", "fileDeleted"],
                            properties: {
                                removed: { type: "boolean" },
                                fileDeleted: { type: "boolean", description: "Whether the underlying file was deleted (no other user referenced it anymore)" }
                            }
                        }
                    }
                }
            },
            "400": {
                description: "Missing media ID",
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
                description: "Track not found in your library",
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

    const mediaId = getRouterParam(event, "id");
    if (!mediaId) {
        throw createError({ statusCode: 400, statusMessage: "Missing media ID" });
    }

    const { removed, fileDeleted } = await deleteLibraryEntryForUser(userId, mediaId);
    if (!removed) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }

    return { removed, fileDeleted };
});
