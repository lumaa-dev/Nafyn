// serves a user's avatar image; any authenticated user can view any other user's avatar (needed to show it around the app)
import { createReadStream, existsSync } from "node:fs";
import { avatarFilePath } from "~~/server/utils/avatar";
import { verifyAuthToken } from "~~/server/utils/jwt";

export default defineEventHandler(async (event) => {
    // <img> elements can't set custom headers, so accept the token as a query param fallback too
    const authHeader = getHeader(event, "Authorization");
    const query = getQuery(event);
    let token = authHeader ?? (typeof query.token === "string" ? query.token : null);

    if (!token) {
        throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
    }

    token = token.startsWith("Bearer ") ? token.slice("Bearer ".length).trim() : token;

    try {
        verifyAuthToken(token);
    } catch {
        throw createError({ statusCode: 401, statusMessage: "Invalid or expired token" });
    }

    const userId = getRouterParam(event, "id");
    if (!userId) {
        throw createError({ statusCode: 400, statusMessage: "Missing user ID" });
    }

    const path = avatarFilePath(userId);
    if (!existsSync(path)) {
        throw createError({ statusCode: 404, statusMessage: "User has no avatar" });
    }

    setResponseHeader(event, "Content-Type", "image/webp");
    setResponseHeader(event, "Cache-Control", "private, max-age=3600");
    return sendStream(event, createReadStream(path));
});
