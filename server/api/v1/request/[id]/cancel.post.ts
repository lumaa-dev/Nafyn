import { getRequestById, updateRequestStatus } from "~~/server/core/requests";
import { notifyRequestCancelled } from "~~/server/core/notifications";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { isRequestActive } from "~~/server/entity/NafynRequest";
import { signalCancel } from "~~/server/utils/requestCancel";
import { emitDownloadProgress } from "~~/server/utils/downloadEvents";

defineRouteMeta({
    openAPI: {
        description: "Cancel a request that hasn't finished: waiting for a manager, queued, or in the download pipeline (searching, downloading, processing). Allowed for the person who made the request and for MANAGE_REQUESTS holders. A waiting request is cancelled at once (`status: cancelled`); one in the pipeline is stopped at its next step (`status: cancelling`, usually within a second or two), and every track it already added to the requester's library is taken back out. The request then ends as `cancelled`, which `/ws/downloads` reports as its last event",
        tags: ["request"],
        operationId: "cancelRequest",
        parameters: [
            { name: "id", in: "path", required: true, description: "Request ID", schema: { type: "string" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["status"],
                            properties: {
                                status: { type: "string", enum: ["cancelled", "cancelling"], description: "`cancelling`: the pipeline was told to stop and will report `cancelled` shortly" }
                            }
                        }
                    }
                }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "Not your request, and no MANAGE_REQUESTS permission", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No request with that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "The request has already finished (completed, failed, denied or cancelled)", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const id = getRouterParam(event, "id");
    if (!id) throw createError({ statusCode: 400, statusMessage: "Missing request ID" });

    const request = await getRequestById(id);
    if (!request) throw createError({ statusCode: 404, statusMessage: "No request with that ID" });

    const requesterId = typeof request.requestedBy === "string" ? request.requestedBy : request.requestedBy?.id;
    if (requesterId !== userId && !hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS)) {
        throw createError({ statusCode: 403, statusMessage: "Unsufficient permissions" });
    }

    if (request.status === "waiting") {
        // "still waiting" is part of the UPDATE: a manager accepting it at the same moment wins or loses cleanly
        if (await updateRequestStatus(id, "cancelled", true)) {
            emitDownloadProgress({ requestId: id, stage: "cancelled", message: "Cancelled" });
            return { status: "cancelled" };
        }
        // accepted in the meantime: it is in the pipeline now, fall through to stopping it there
    }

    const current = request.status === "waiting" ? await getRequestById(id) : request;
    if (!current || !isRequestActive(current.status)) {
        throw createError({ statusCode: 409, statusMessage: "This request has already finished" });
    }

    // the pipeline holds it: it stops at its next step, takes back what it added and reports "cancelled"
    if (signalCancel(id)) return { status: "cancelling" };

    // nothing in this process runs it (a server restart left it searching/downloading/processing): it can never
    // finish, so it is simply marked cancelled - which also makes it deletable again
    await updateRequestStatus(id, "cancelled");
    emitDownloadProgress({ requestId: id, stage: "cancelled", message: "Cancelled" });
    notifyRequestCancelled(id);
    return { status: "cancelled" };
});
