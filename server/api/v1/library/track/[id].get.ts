import { getSongOfUser } from "~~/server/core/library";
import { getImageColors } from "~~/server/utils/imageColors";

defineRouteMeta({
    openAPI: {
        description: "Get one track the requesting user owns, by Nafyn media ID - used by the library track view (Play, no Request button)",
        tags: ["library"],
        operationId: "getLibraryTrack",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "Nafyn's internal media ID",
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
                            allOf: [
                                { $ref: "#/components/schemas/MediaRow" },
                                {
                                    type: "object",
                                    required: ["imageColors", "textColor"],
                                    properties: {
                                        imageColors: { type: "array", items: { type: "string" }, description: "Dominant colors extracted from the track's cover art, most-dominant first" },
                                        textColor: { type: "string", description: "Black or white, whichever contrasts best (WCAG) against `imageColors[0]`" }
                                    }
                                }
                            ]
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
                description: "No such track owned by the requesting user",
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
    if (!mediaId) throw createError({ statusCode: 400, statusMessage: "Missing track ID" });

    const song = await getSongOfUser(userId, mediaId);
    if (!song) throw createError({ statusCode: 404, statusMessage: "No owned track with ID " + mediaId });

    const { imageColors, textColor } = await getImageColors({
        coverArtUrl: song.coverArt,
        customCoverMediaId: song.hasCustomCover ? song.id : null
    });

    // filePath is an internal disk path, not for the client
    const { filePath: _filePath, ...track } = song;
    return { ...track, imageColors, textColor };
});
