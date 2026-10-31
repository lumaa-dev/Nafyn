// serves a user's avatar image; public, because it is part of the public profile page (see profile/[username].get.ts)
import { createReadStream, existsSync } from "node:fs";
import { avatarFilePath } from "~~/server/utils/avatar";

defineRouteMeta({
    openAPI: {
        description: "Serve a user's avatar image. Public (no login needed): it is shown on the user's public profile page and in its link previews. A `?token=` query param is accepted and ignored",
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
    // Public: an avatar is part of a user's public profile page (`/u/<username>`), whose link previews are
    // fetched by crawlers that are not logged in.
    const userId = getRouterParam(event, "id");
    if (!userId) {
        throw createError({ statusCode: 400, statusMessage: "Missing user ID" });
    }

    const path = avatarFilePath(userId);
    if (!existsSync(path)) {
        throw createError({ statusCode: 404, statusMessage: "User has no avatar" });
    }

    setResponseHeader(event, "Content-Type", "image/webp");
    setResponseHeader(event, "Cache-Control", "public, max-age=3600");
    return sendStream(event, createReadStream(path));
});
