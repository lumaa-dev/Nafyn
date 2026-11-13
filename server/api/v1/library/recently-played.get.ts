import { getRecentlyPlayed } from "~~/server/core/recentlyPlayed";

defineRouteMeta({
    openAPI: {
        description: "List the requesting user's recently played tracks/albums/playlists, most recent first",
        tags: ["library"],
        operationId: "getRecentlyPlayed",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: { $ref: "#/components/schemas/RecentlyPlayedEntry" }
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
                    RecentlyPlayedEntry: {
                        type: "object",
                        required: ["type", "refId", "playedAt", "title", "subtitle", "coverArt", "playlistImage", "href"],
                        properties: {
                            type: { type: "string", enum: ["track", "album", "playlist"] },
                            refId: { type: "string", description: "MusicBrainz ID (track), release-group ID (album), or playlist ID" },
                            playedAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            title: { type: "string" },
                            subtitle: { type: "string", nullable: true },
                            coverArt: { type: "string", nullable: true },
                            coverMediaId: { type: "string", nullable: true, description: "A track carrying an uploaded cover (the track itself, or one of the album's): GET /api/v1/library/{coverMediaId}/cover wins over coverArt" },
                            playlistImage: { type: "string", nullable: true, description: "Only set for type \"playlist\"; the raw image version stamp" },
                            href: { type: "string", description: "Relative app URL to open this item" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    return await getRecentlyPlayed(userId);
});
