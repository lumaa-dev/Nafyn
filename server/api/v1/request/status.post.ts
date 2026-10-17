import { processDownloadRequestId } from "~~/server/core/downloads";
import { getRequestById, updateRequestStatus } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import type { RequestStatus } from "~~/server/entity/NafynRequest";
import { notifyRequestAccepted, notifyRequestDenied } from "~~/server/core/notifications";

// a manager's only two decisions on a waiting request: accept it (starts the download) or deny it. "failed" is
// still accepted for older clients and read as a denial - it was how a request got refused before "denied"
// existed. Every other status belongs to the download pipeline, not to a person.
const REQUEST_STATUSES: RequestStatus[] = ["searching", "denied", "failed"];

defineRouteMeta({
    openAPI: {
        description: "Accept or deny a waiting request. Requires MANAGE_REQUESTS. \"searching\" accepts it and starts the download pipeline; \"denied\" refuses it (\"failed\" is accepted as a legacy alias for \"denied\"). Both notify the requester and request managers",
        tags: ["request"],
        operationId: "updateRequestStatus",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["requestId", "status"],
                        properties: {
                            requestId: { type: "string" },
                            status: { type: "string", enum: ["searching", "denied", "failed"] }
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
                description: "Malformed request",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated, or missing MANAGE_REQUESTS permission",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "500": {
                description: "Request status couldn't be modified (e.g. it wasn't in \"waiting\" state)",
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
  const { sub: userId } = await requireAuthToken(event);
  const permcount = await getPermissionsById(userId);

  if (!permcount) {
    throw createError({ statusCode: 401, message: "Invalid user authentication" });
  }

  if (!hasPermission(permcount, Permission.MANAGE_REQUESTS)) {
    throw createError({ statusCode: 401, message: "Unsufficient permissions" });
  }

  const body = await readBody(event);

  const requestId: string | null = typeof body?.requestId == "string" ? body?.requestId : null;
  const rawStatus: unknown = body?.status;

  // the old code cast whatever string arrived straight to RequestStatus and handed it to the UPDATE, so an
  // arbitrary value reached the column's CHECK constraint and came back as an unhandled 500. Validate here.
  if (!requestId || typeof rawStatus !== "string" || !REQUEST_STATUSES.includes(rawStatus as RequestStatus)) {
    throw createError({ statusCode: 400, message: "Malformed request" })
  }

  const newStatus: RequestStatus = rawStatus === "failed" ? "denied" : rawStatus as RequestStatus;

  if (await updateRequestStatus(requestId, newStatus, true)) {
    const request = await getRequestById(requestId);
    if (request) {
      if (newStatus == "searching") notifyRequestAccepted(request, userId);
      else notifyRequestDenied(request, userId);
    }
    if (newStatus == "searching") {
      processDownloadRequestId(requestId);
    }
    return request;
  } else {
    throw createError({ statusCode: 500, message: "Request status couldn't be modified" })
  }
})