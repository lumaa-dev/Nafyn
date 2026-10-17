import { APN_ACTIVITY_KINDS, currentNowPlayingSessionId, isValidApnToken, registerActivityToken, type ApnActivityKind } from "~~/server/utils/apn";
import { getRequestById } from "~~/server/core/requests";
import { getSubscriptionById } from "~~/server/core/releaseSubscriptions";

defineRouteMeta({
    openAPI: {
        description: "Register the update token of a running Live Activity or Now Playing remote session, so the server can update and end it. `refId` is the request id (kind request), release subscription id (kind release) or the remote session's `attributes.id` (kind nowplaying), and must belong to the caller",
        tags: ["user"],
        operationId: "registerActivityToken",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["kind", "refId", "token"],
                        properties: {
                            kind: { type: "string", enum: ["request", "release", "nowplaying"] },
                            refId: { type: "string" },
                            token: { type: "string", description: "Hex-encoded activity push token" },
                            environment: { type: "string", enum: ["sandbox", "production"], description: "Defaults to production" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": { description: "" },
            "400": { description: "Malformed kind, refId, token or environment", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No such request/subscription/session belonging to the caller", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

// SECURITY: an update token lets the server push into whatever activity it addresses, and the refId decides
// which server-side event feeds it - so a refId must be the caller's own, or one user could subscribe their
// device to another user's request progress
async function ownsRef(userId: string, kind: ApnActivityKind, refId: string): Promise<boolean> {
    if (kind === "request") {
        const request = await getRequestById(refId);
        if (!request?.requestedBy) return false;
        const requester = typeof request.requestedBy === "string" ? request.requestedBy : request.requestedBy.id;
        return requester === userId;
    }
    if (kind === "release") {
        return (await getSubscriptionById(refId))?.userId === userId;
    }
    return currentNowPlayingSessionId(userId) === refId;
}

export default defineEventHandler(async (event) => {
    const { sub: userId, jti } = await requireAuthToken(event);
    const body = await readBody(event).catch(() => null);

    const kind = body?.kind;
    const refId = body?.refId;
    if (!(APN_ACTIVITY_KINDS as readonly string[]).includes(kind) || typeof refId !== "string" || refId.length === 0 || refId.length > 64) {
        throw createError({ statusCode: 400, statusMessage: "Malformed request" });
    }
    if (!isValidApnToken(body?.token)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid APNs token" });
    }
    const environment = body?.environment ?? "production";
    if (environment !== "sandbox" && environment !== "production") {
        throw createError({ statusCode: 400, statusMessage: "environment must be sandbox or production" });
    }

    if (!await ownsRef(userId, kind, refId)) {
        throw createError({ statusCode: 404, statusMessage: "Nothing to attach this activity to" });
    }

    await registerActivityToken(userId, jti, { kind, refId, token: body.token, environment });
    return { registered: true };
});
