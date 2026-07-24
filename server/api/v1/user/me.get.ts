import { getUserById } from "../../../core/users";
import { requireAuthToken } from "../../../utils/requireAuth";

export default defineEventHandler(async (event) => {
    const { sub } = requireAuthToken(event);
    const user = getUserById(sub);
    
    if (!user) {
        throw createError({ statusCode: 404, statusMessage: "User not found" });
    }

    return user;
});
