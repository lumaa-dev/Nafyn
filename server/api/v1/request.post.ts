import { createMediaRequest } from "~~/server/core/requestCreate";
import { assertMbid } from "~~/server/utils/ids";

defineRouteMeta({
    openAPI: {
        description: "Create a download request for an album or track by MusicBrainz ID. If the requesting user has the matching AUTOACCEPT permission, the download starts immediately; otherwise it's queued as \"waiting\" for a MANAGE_REQUESTS user to accept. Unreleased media can never be requested, whatever the caller's permissions - subscribe to it instead (POST /api/v1/subscriptions). Nor can media the caller already has: a track already in their library (matched by MusicBrainz ID including merged/redirected IDs, by ISRC, or by title + artist + duration), or an album whose every track is - an album only partly in the library can be requested, and only its missing tracks are downloaded. The request is stored under the MusicBrainz ID that the given one currently resolves to",
        tags: ["request"],
        operationId: "createRequest",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["id", "type"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz ID (recording ID for a track, release-group ID for an album)" },
                            type: { type: "string", enum: ["album", "track"] }
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
                        schema: { $ref: "#/components/schemas/NafynRequest" }
                    }
                }
            },
            "400": {
                description: "Incorrect MusicBrainz ID or media type",
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
                description: "Missing REQUEST_ALBUMS/REQUEST_TRACKS, or the media isn't released yet",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Nothing on MusicBrainz for this ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "409": {
                description: "The caller already has this in their library (every track of it, for an album), or a request for it that is waiting or being processed",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "429": {
                description: "The caller already has too many requests waiting or downloading (NAFYN_MAX_ACTIVE_REQUESTS_PER_USER, default 500); see Retry-After",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "502": {
                description: "MusicBrainz could not be reached, so whether the caller already has this could not be checked",
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
                    NafynRequest: {
                        type: "object",
                        required: ["id", "musicbrainzId", "info", "type", "status", "requestedBy", "createdAt", "updatedAt"],
                        properties: {
                            id: { type: "string" },
                            musicbrainzId: { type: "string" },
                            info: {
                                $ref: "#/components/schemas/MediaInfo",
                                nullable: true
                            },
                            type: { type: "string", enum: ["album", "track"] },
                            status: { type: "string", enum: ["waiting", "searching", "downloading", "processing", "completed", "failed", "denied"] },
                            requestedBy: {
                                type: ["object", "string"],
                                oneOf: [
                                    { $ref: "#/components/schemas/NafynUser" },
                                    { type: "string" }
                                ]
                            },
                            createdAt: { type: "string", format: "date-time" },
                            updatedAt: { type: "string", format: "date-time" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const body = await readBody(event);
    const type: string | null = typeof body?.type == "string" ? body?.type : null

    if (type !== "album" && type !== "track") {
        throw createError({ statusCode: 400, message: "Incorrect media type" })
    }

    // SECURITY: a MusicBrainz ID is a UUID, and it is interpolated into an upstream MusicBrainz REST path
    // (`/ws/2/recording/<id>`) by resolveTargets. Validating the shape stops extra path segments or a query
    // string being spliced into that upstream request.
    const mbId: string = assertMbid(body?.id);

    // every check (permissions, the per-account ceiling on active requests, ownership, duplicates, release date)
    // lives in createMediaRequest, shared with playlist imports
    const result = await createMediaRequest(userId, mbId, type);
    if (!result.ok) {
        if (result.retryAfterSeconds) setResponseHeader(event, "Retry-After", result.retryAfterSeconds);
        throw createError({ statusCode: result.statusCode, message: result.message });
    }
    return result.request;
})
