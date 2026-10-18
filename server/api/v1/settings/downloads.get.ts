// admin: the instance-wide cap on requests processed at once
import { getMaxConcurrentDownloads } from "~~/server/core/downloadQueue";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "How many requests may search/download/process at once on this instance. Requires ADMIN",
        tags: ["settings"],
        operationId: "getDownloadLimit",
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
    return { maxConcurrent: await getMaxConcurrentDownloads() };
});
