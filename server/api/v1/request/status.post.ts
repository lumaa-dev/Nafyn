import { processDownloadRequestId } from "~~/server/core/downloads";
import { getRequestById, updateRequestStatus } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import type { RequestStatus } from "~~/server/entity/NafynRequest";

const REQUEST_STATUSES: RequestStatus[] = ["waiting", "searching", "downloading", "processing", "completed", "failed"];

defineRouteMeta({
    openAPI: {
        description: "Update a waiting request's status. Requires MANAGE_REQUESTS. Setting status to \"searching\" starts the download pipeline for it",
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
                            status: { type: "string", enum: ["waiting", "searching", "downloading", "processing", "completed", "failed"] }
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
  const { sub: userId } = requireAuthToken(event);
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

  const newStatus = rawStatus as RequestStatus;

  if (await updateRequestStatus(requestId, newStatus, true)) {
    if (newStatus == "searching") {
      processDownloadRequestId(requestId);
    }
    return await getRequestById(requestId);
  } else {
    throw createError({ statusCode: 500, message: "Request status couldn't be modified" })
  }
})