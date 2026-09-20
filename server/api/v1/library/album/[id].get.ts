import { getAlbumOfUser, getAlbumSongsOfUser } from "~~/server/core/library";
import { getImageColors } from "~~/server/utils/imageColors";

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
                                album: {
                                    type: "object",
                                    allOf: [
                                        { $ref: "#/components/schemas/AlbumRow" },
                                        {
                                            type: "object",
                                            required: ["imageColors", "textColor"],
                                            properties: {
                                                imageColors: { type: "array", items: { type: "string" }, description: "Dominant colors extracted from the album's cover art, most-dominant first" },
                                                textColor: { type: "string", description: "Black or white, whichever contrasts best (WCAG) against `imageColors[0]`" }
                                            }
                                        }
                                    ]
                                },
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

    const { imageColors, textColor } = await getImageColors({
        coverArtUrl: album.coverArt,
        customCoverMediaId: album.coverMediaId
    });

    // filePath is an internal disk path, not for the client
    return { album: { ...album, imageColors, textColor }, tracks: tracks.map(({ filePath: _filePath, ...track }) => track) };
});
