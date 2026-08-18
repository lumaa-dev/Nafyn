import { createRegisterToken } from "~~/server/core/registerTokens";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    if (!hasPermission(getPermissionsById(userId) ?? 0, Permission.MANAGE_ACCOUNTS)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    return createRegisterToken(userId);
});
