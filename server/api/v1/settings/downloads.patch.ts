import { setMaxConcurrentDownloads } from "~~/server/core/downloadQueue";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "Set how many requests may search/download/process at once; the rest queue. Requires ADMIN",
        tags: ["settings"],
        operationId: "setDownloadLimit",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["maxConcurrent"],
                        properties: { maxConcurrent: { type: "integer", minimum: 1, maximum: 100 } }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["maxConcurrent"],
                            properties: { maxConcurrent: { type: "integer" } }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.ADMIN)) {
        throw createError({ statusCode: 401, message: "Unsufficient permissions" });
    }

    const body = await readBody(event);
    const limit = body?.maxConcurrent;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw createError({ statusCode: 400, message: "'maxConcurrent' must be an integer between 1 and 100" });
    }

    await setMaxConcurrentDownloads(limit);
    return { maxConcurrent: limit };
});
