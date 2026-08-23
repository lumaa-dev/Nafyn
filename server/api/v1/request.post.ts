import type { UUID } from "crypto";
import { processDownloadRequest } from "~~/server/core/downloads";
import { createRequest } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { NafynRequest } from "~~/server/entity/NafynRequest";
import { assertMbid } from "~~/server/utils/ids";
import { consumeRateLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "Create a download request for an album or track by MusicBrainz ID. If the requesting user has the matching AUTOACCEPT permission, the download starts immediately; otherwise it's queued as \"waiting\" for a MANAGE_REQUESTS user to accept",
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
                            status: { type: "string", enum: ["waiting", "searching", "downloading", "processing", "completed", "failed"] },
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

// each request triggers a MusicBrainz lookup and, with AUTOACCEPT, a Soulseek search + download - a
// per-account ceiling keeps one account from queueing thousands of them
const MAX_REQUESTS = 30;
const REQUEST_WINDOW_MS = 10 * 60 * 1000;

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const rateLimit = consumeRateLimit(`request:${userId}`, MAX_REQUESTS, REQUEST_WINDOW_MS);
    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, message: "Too many requests queued, try again later" });
    }

    const body = await readBody(event);
    const type: string | null = typeof body?.type == "string" ? body?.type : null

    if (type !== "album" && type !== "track") {
        throw createError({ statusCode: 400, message: "Incorrect media type" })
    }

    // SECURITY: a MusicBrainz ID is a UUID, and it is interpolated into an upstream MusicBrainz REST path
    // (`/ws/2/recording/<id>`) by resolveTargets. Validating the shape stops extra path segments or a query
    // string being spliced into that upstream request.
    const mbId: string = assertMbid(body?.id);

    let permcount: number = await getPermissionsById(userId) ?? 0

    // SECURITY: the REQUEST_ALBUMS / REQUEST_TRACKS permission bits were declared but never checked here,
    // so every authenticated account could queue downloads regardless of what an admin had granted it.
    const required = type == "album" ? Permission.REQUEST_ALBUMS : Permission.REQUEST_TRACKS;
    if (!hasPermission(permcount, required)) {
        throw createError({ statusCode: 403, message: "Unsufficient permissions" })
    }

    let autoAccept: boolean = hasPermission(permcount, type == "album" ? Permission.AUTOACCEPT_ALBUMS : Permission.AUTOACCEPT_TRACKS);

    let newRequest: NafynRequest = await createRequest(mbId as UUID, type, userId as UUID, autoAccept ? "searching" : "waiting");
    if (autoAccept) {
        processDownloadRequest(newRequest);
    }

    return newRequest
})