// serves a user's avatar image; any authenticated user can view any other user's avatar (needed to show it around the app)
import { createReadStream, existsSync } from "node:fs";
import { avatarFilePath } from "~~/server/utils/avatar";
import { verifyAuthToken } from "~~/server/utils/jwt";

defineRouteMeta({
    openAPI: {
        description: "Serve a user's avatar image. Any authenticated user can view any other user's avatar. Since <img> elements can't set custom headers, the token may be passed as a `?token=` query param instead",
        tags: ["user"],
        operationId: "getUserAvatar",
        parameters: [
            {
                name: "id",
                in: "path",
                required: true,
                description: "User ID",
                schema: { type: "string" }
            },
            {
                name: "token",
                in: "query",
                required: false,
                description: "Auth token, as a fallback for clients that can't set the Authorization header",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "image/webp": { schema: { type: "string", format: "binary" } }
                }
            },
            "400": {
                description: "Missing user ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "User has no avatar",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        }
    },
});

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
