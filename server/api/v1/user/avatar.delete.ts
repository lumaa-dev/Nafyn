import { getUserById, updateUser } from "~~/server/core/users";
import { deleteAvatar } from "~~/server/utils/avatar";

export default defineEventHandler(async (event) => {
    const { sub } = requireAuthToken(event);

    if (!getUserById(sub)) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    await deleteAvatar(sub);

    return updateUser(sub, { avatar: null });
});
