import { getUserById, updateUser } from "~~/server/core/users";
import { saveAvatar } from "~~/server/utils/avatar";

export default defineEventHandler(async (event) => {
    const { sub } = requireAuthToken(event);

    if (!getUserById(sub)) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    const form = await readMultipartFormData(event);
    const file = form?.find((part) => part.name === "avatar");
    if (!file?.data?.length) {
        throw createError({ statusCode: 400, statusMessage: "Missing `avatar` file" });
    }

    await saveAvatar(sub, file.data);

    // cache-busting token for clients building the avatar URL, actual bytes are always at the same path
    return updateUser(sub, { avatar: Date.now().toString() });
});
