import { getRequestById } from "~~/server/core/requests";
import { getPermissionsById, getUserById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import type { NafynRequest } from "~~/server/entity/NafynRequest";

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);

  const user = getUserById(userId);
  const reqId = getRouterParam(event, 'id');

  if (!user) {
    throw createError({ statusCode: 400, message: "Couldn't match token with user" })
  }

  if (!reqId) {
    throw createError({ statusCode: 400, message: "Missing request ID" })
  }

  const request: NafynRequest | null = await getRequestById(reqId);
  if (!request) {
    throw createError({ statusCode: 404, message: "No request with ID " + reqId })
  }

  const inaccessible: boolean = request.requestedBy != userId && !hasPermission(getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS);
  if (inaccessible) {
    throw createError({ statusCode: 404, message: "No request with ID " + reqId })
  }

  return request;
})
