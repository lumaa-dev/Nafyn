import type { UUID } from "crypto";
import { processDownloadRequest } from "~~/server/core/downloads";
import { createRequest, hasActiveRequest } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { NafynRequest } from "~~/server/entity/NafynRequest";
import { assertMbid } from "~~/server/utils/ids";
import { getMediaInfo } from "~~/server/utils/musicbrainz";
import { isReleased } from "~~/server/utils/releaseDate";
import { notifyRequestCreated } from "~~/server/core/notifications";
import { consumeRateLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "Create a download request for an album or track by MusicBrainz ID. If the requesting user has the matching AUTOACCEPT permission, the download starts immediately; otherwise it's queued as \"waiting\" for a MANAGE_REQUESTS user to accept. Unreleased media can never be requested, whatever the caller's permissions - subscribe to it instead (POST /api/v1/subscriptions)",
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
            "409": {
                description: "The caller already has a request for this that is waiting or being processed",
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

// each request triggers a MusicBrainz lookup and, with AUTOACCEPT, a Soulseek search + download - a
// per-account ceiling keeps one account from queueing thousands of them
const MAX_REQUESTS = 30;
const REQUEST_WINDOW_MS = 10 * 60 * 1000;

// requests currently being created, keyed by user + MusicBrainz ID. The "already requested" check below reads
// the database, so two clicks landing in the same instant would both pass it before either row exists;
// this closes that gap within the (single) server process.
const inFlight = new Set<string>();

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

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

    // unreleased media can't be requested by anyone - ADMIN included, there's simply nothing to download yet.
    // A failed lookup isn't treated as "unreleased": the pipeline re-checks the date before searching anyway.
    const info = await getMediaInfo(mbId, type).catch(() => null);
    if (info && !isReleased(info.releaseDate)) {
        throw createError({ statusCode: 403, message: "Not released yet" });
    }

    let autoAccept: boolean = hasPermission(permcount, type == "album" ? Permission.AUTOACCEPT_ALBUMS : Permission.AUTOACCEPT_TRACKS);

    // one live request per user and item: the button on the album/track page disables itself, but that is a
    // courtesy - a second tab, a script or a double click must not queue the same download again
    const flightKey = `${userId}:${mbId}`;
    if (inFlight.has(flightKey) || await hasActiveRequest(userId, mbId)) {
        throw createError({ statusCode: 409, message: "You already requested this" });
    }

    inFlight.add(flightKey);
    let newRequest: NafynRequest;
    try {
        newRequest = await createRequest(mbId as UUID, type, userId as UUID, autoAccept ? "searching" : "waiting");
    } finally {
        inFlight.delete(flightKey);
    }

    notifyRequestCreated(newRequest, autoAccept);
    if (autoAccept) {
        processDownloadRequest(newRequest);
    }

    return newRequest
})