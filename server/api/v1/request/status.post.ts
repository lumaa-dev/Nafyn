import { processDownloadRequestId } from "~~/server/core/downloads";
import { getRequestById, updateRequestStatus } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import type { RequestStatus } from "~~/server/entity/NafynRequest";

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
  const newStatus: RequestStatus | null = typeof body?.status == "string" ? body?.status as RequestStatus : null;

  if (!requestId || !newStatus) {
    throw createError({ statusCode: 400, message: "Malformed request" })
  }

  if (await updateRequestStatus(requestId, newStatus, true)) {
    if (newStatus == "searching") {
      processDownloadRequestId(requestId);
    }
    return await getRequestById(requestId);
  } else {
    throw createError({ statusCode: 500, message: "Request status couldn't be modified" })
  }
})