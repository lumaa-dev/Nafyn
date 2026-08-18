import { getPlaylistById, updatePlaylist } from "~~/server/core/playlists";
import { savePlaylistImage } from "~~/server/utils/playlistImage";

defineRouteMeta({
    openAPI: {
        description: "Upload/replace a playlist's cover image. Owner only",
        tags: ["playlist"],
        operationId: "setPlaylistImage",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            }
        ],
        requestBody: {
            content: {
                "multipart/form-data": {
                    schema: {
                        type: "object",
                        required: ["image"],
                        properties: {
                            image: { type: "string", format: "binary" }
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
                description: "Missing playlist ID or `image` file",
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
            "403": {
                description: "Only the playlist owner can change its image",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist not found",
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

    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = await getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    if (playlist.ownerId !== userId) {
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can change its image" });
    }

    const form = await readMultipartFormData(event);
    const file = form?.find((part) => part.name === "image");
    if (!file?.data?.length) {
        throw createError({ statusCode: 400, statusMessage: "Missing `image` file" });
    }

    await savePlaylistImage(pid, file.data);

    // cache-busting token for clients building the image URL, actual bytes are always at the same path
    return await updatePlaylist(pid, { image: Date.now().toString() });
});
