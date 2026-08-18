import { recordRecentlyPlayed, type RecentlyPlayedType } from "~~/server/core/recentlyPlayed";
import { findLibraryEntry, userOwnsAlbum } from "~~/server/core/library";
import { getPlaylistById, hasAccess } from "~~/server/core/playlists";

const TYPES: RecentlyPlayedType[] = ["track", "album", "playlist"];

defineRouteMeta({
    openAPI: {
        description: "Record a track/album/playlist as recently played for the requesting user; only ever records media the user can actually see",
        tags: ["library"],
        operationId: "recordRecentlyPlayed",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["type", "refId"],
                        properties: {
                            type: { type: "string", enum: ["track", "album", "playlist"] },
                            refId: { type: "string", description: "Media ID (track), release-group ID (album), or playlist ID" }
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
                        schema: {
                            type: "object",
                            required: ["recorded"],
                            properties: {
                                recorded: { type: "boolean" }
                            }
                        }
                    }
                }
            },
            "400": {
                description: "`type` and `refId` are required",
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
                description: "Track/album not in your library, or playlist not found/accessible",
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
    const type: unknown = body?.type;
    const refId: unknown = body?.refId;

    if (typeof type !== "string" || !TYPES.includes(type as RecentlyPlayedType) || typeof refId !== "string" || !refId) {
        throw createError({ statusCode: 400, statusMessage: "`type` and `refId` are required" });
    }

    // only ever record media the requesting user can actually see, so recently-played can't be used to probe
    // other users' library/playlist contents
    if (type === "track" && !await findLibraryEntry(userId, refId)) {
        throw createError({ statusCode: 404, statusMessage: "Track not found in your library" });
    }
    if (type === "album" && !await userOwnsAlbum(userId, refId)) {
        throw createError({ statusCode: 404, statusMessage: "Album not found in your library" });
    }
    if (type === "playlist") {
        const playlist = await getPlaylistById(refId);
        if (!playlist || !await hasAccess(playlist, userId)) {
            throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
        }
    }

    await recordRecentlyPlayed(userId, type as RecentlyPlayedType, refId);
    return { recorded: true };
});
