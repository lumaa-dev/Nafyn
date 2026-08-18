import { getUserById, updateUser, getPermissionsById } from "~~/server/core/users";
import { canManageUser } from "~~/server/entity/Permission";
import { saveAvatar } from "~~/server/utils/avatar";

export default defineEventHandler(async (event) => {
    const { sub: actorId } = requireAuthToken(event);
    const actorPerms = getPermissionsById(actorId) ?? 0;

    const targetId = getRouterParam(event, "id");
    if (!targetId) {
        throw createError({ statusCode: 400, statusMessage: "Missing user ID" });
    }

    const target = getUserById(targetId);
    if (!target) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    if (!canManageUser(actorId, actorPerms, targetId, target.permissions as unknown as number)) {
        throw createError({ statusCode: 401, statusMessage: "Unsufficient permissions" });
    }

    const form = await readMultipartFormData(event);
    const file = form?.find((part) => part.name === "avatar");
    if (!file?.data?.length) {
        throw createError({ statusCode: 400, statusMessage: "Missing `avatar` file" });
    }

    await saveAvatar(targetId, file.data);

    return updateUser(targetId, { avatar: Date.now().toString() });
});
