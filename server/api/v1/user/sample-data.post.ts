// dev-only: turns sample data on/off for the requesting user. 404s in production - see sample-data.get.ts.
import { enableSampleData, disableSampleData, isSampleDataEnabled } from "~~/server/core/sampleData";

defineRouteMeta({
    openAPI: {
        description: "Dev-mode only. Fills (or clears) the requesting user's library, playlists and listening insights with a fixed catalog of real sample tracks.",
        tags: ["user"],
        operationId: "setSampleDataState",
        requestBody: {
            content: { "application/json": { schema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] } } }
        },
        responses: {
            "200": { description: "" },
            "400": { description: "Missing/invalid `enabled`" },
            "401": { description: "Not authenticated" },
            "404": { description: "Not running in development" }
        }
    },
});

export default defineEventHandler(async (event) => {
    if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: "Not found" });

    const { sub: userId } = requireAuthToken(event);
    const body = await readBody(event);

    if (typeof body?.enabled !== "boolean") {
        throw createError({ statusCode: 400, statusMessage: "`enabled` must be a boolean" });
    }

    if (body.enabled) {
        const summary = await enableSampleData(userId);
        return { enabled: true, ...summary };
    }

    await disableSampleData(userId);
    return { enabled: await isSampleDataEnabled(userId) };
});
