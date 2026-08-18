import { setRegistrationOpen } from "~~/server/core/appSettings";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    if (!hasPermission(getPermissionsById(userId) ?? 0, Permission.MANAGE_ACCOUNTS)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const body = await readBody(event);
    if (typeof body?.open !== "boolean") {
        throw createError({ statusCode: 400, statusMessage: "Missing 'open' boolean" });
    }

    setRegistrationOpen(body.open);

    return { open: body.open };
});
