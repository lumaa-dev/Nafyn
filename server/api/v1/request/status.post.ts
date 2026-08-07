import { processDownloadRequestId } from "~~/server/core/downloads";
import { getRequestById, updateRequestStatus } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import type { RequestStatus } from "~~/server/entity/NafynRequest";

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);
  const permcount = getPermissionsById(userId);

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