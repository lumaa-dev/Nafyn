// dev-only: whether the requesting user currently has sample data loaded. 404s in production so the
// feature (and its existence) is invisible outside development.
import { isSampleDataEnabled } from "~~/server/core/sampleData";

defineRouteMeta({
    openAPI: {
        description: "Dev-mode only.",
        tags: ["user"],
        operationId: "getSampleDataState",
        responses: {
            "200": { description: "" },
            "401": { description: "Not authenticated" },
            "404": { description: "Not running in development" }
        }
    },
});

export default defineEventHandler(async (event) => {
    if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: "Not found" });

    const { sub: userId } = requireAuthToken(event);
    return { enabled: await isSampleDataEnabled(userId) };
});
