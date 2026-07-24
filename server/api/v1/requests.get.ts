import { listRequests } from "~~/server/core/requests";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

export default defineEventHandler(async (event) => {
  const { sub: userId } = requireAuthToken(event);

  if (!hasPermission(getPermissionsById(userId) ?? 0, Permission.MANAGE_REQUESTS)) {
    throw createError({ statusCode: 401, message: "Unsufficient permissions" });
  }

  return await listRequests()
})
