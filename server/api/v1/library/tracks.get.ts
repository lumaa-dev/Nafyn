import { getMediaOfUser } from "~~/server/core/library";

defineRouteMeta({
    openAPI: {
        description: "List every track in the requesting user's library",
        tags: ["library"],
        operationId: "getLibraryTracks",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/MediaRow" }
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
            }
        },
        $global: {
            components: {
                schemas: {
                    MediaRow: {
                        type: "object",
                        required: ["id", "musicbrainzId", "title", "artistName", "artistMbid", "album", "albumId", "albumType", "coverArt", "releaseDate", "duration", "label", "fingerprint", "amId", "fileSize", "addedAt"],
                        properties: {
                            id: { type: "string", description: "Nafyn's internal media ID" },
                            musicbrainzId: { type: "string", description: "MusicBrainz recording ID" },
                            title: { type: "string" },
                            artistName: { type: "string" },
                            artistMbid: { type: "string", nullable: true },
                            album: { type: "string", nullable: true },
                            albumId: { type: "string", description: "MusicBrainz release-group ID" },
                            albumType: { type: "string", enum: ["album", "ep"], nullable: true },
                            coverArt: { type: "string", nullable: true },
                            releaseDate: { type: "number", nullable: true, description: "Unix timestamp (seconds)" },
                            duration: { type: "number", description: "Seconds" },
                            label: { type: "string", nullable: true },
                            fingerprint: { type: "string", nullable: true, description: "AcoustID fingerprint" },
                            amId: { type: "string", nullable: true, description: "Apple Music identifier" },
                            fileSize: { type: "number", nullable: true, description: "Bytes" },
                            addedAt: { type: "number", description: "Unix timestamp (milliseconds)" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);

  return await getMediaOfUser(userId);
})
