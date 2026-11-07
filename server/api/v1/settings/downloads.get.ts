// admin: the instance-wide cap on requests processed at once (fixed at 1)
import { MAX_CONCURRENT_DOWNLOADS } from "~~/server/core/downloadQueue";
import { getPermissionsById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";

defineRouteMeta({
    openAPI: {
        description: "How many requests may search/download/process at once on this instance. Always 1, it cannot be changed. Requires ADMIN",
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
    return { maxConcurrent: MAX_CONCURRENT_DOWNLOADS };
});
