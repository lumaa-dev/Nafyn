import { getAlbumOfUser, getAlbumSongsOfUser } from "~~/server/core/library";

defineRouteMeta({
    openAPI: {
        description: "Get one album's metadata plus only the tracks the requesting user owns from it - used by the library album view (Play/Shuffle, no Request buttons, hides tracks the user doesn't have)",
        tags: ["library"],
        operationId: "getLibraryAlbum",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "MusicBrainz release-group ID",
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
                            required: ["album", "tracks"],
                            properties: {
                                album: { $ref: "#/components/schemas/AlbumRow" },
                                tracks: { type: "array", items: { $ref: "#/components/schemas/MediaRow" } }
                            }
                        }
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
                description: "The requesting user owns no track from this album",
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
    const albumId = getRouterParam(event, "id");
    if (!albumId) throw createError({ statusCode: 400, statusMessage: "Missing album ID" });

    const album = await getAlbumOfUser(userId, albumId);
    if (!album) throw createError({ statusCode: 404, statusMessage: "No owned album with ID " + albumId });

    const tracks = await getAlbumSongsOfUser(userId, albumId);
    // filePath is an internal disk path, not for the client
    return { album, tracks: tracks.map(({ filePath: _filePath, ...track }) => track) };
});
