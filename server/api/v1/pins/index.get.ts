import { listPins } from "~~/server/core/pins";
import { requireAuthToken } from "~~/server/utils/requireAuth";

defineRouteMeta({
    openAPI: {
        description: "The caller's pinned albums, playlists and tracks, newest pin first. A pin whose target is gone (or no longer visible to the caller) is dropped",
        tags: ["pins"],
        operationId: "getPins",
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: {
                                type: "object",
                                required: ["kind", "refId", "pinnedAt", "title", "href"],
                                properties: {
                                    kind: { type: "string", enum: ["album", "playlist", "track"] },
                                    refId: { type: "string", description: "Media ID (track), release-group MBID (album) or playlist ID" },
                                    pinnedAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                                    title: { type: "string" },
                                    subtitle: { type: "string", nullable: true },
                                    href: { type: "string", description: "Page in the web app" },
                                    coverArt: { type: "string", nullable: true },
                                    coverMediaId: { type: "string", nullable: true },
                                    media: { type: "object", nullable: true, description: "The track (kind `track`)" },
                                    playlistImage: { type: "string", nullable: true },
                                    isOwner: { type: "boolean", description: "Playlists: the caller owns it" },
                                    isMember: { type: "boolean", description: "Playlists: the caller was invited to it" }
                                }
                            }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    return await listPins(userId);
});
