// serves the rendered highlight-reel MP4.
import { createReadStream, statSync } from "node:fs";
import { getYearSnapshot } from "~~/server/core/insightsSnapshot";
import { reelFilePath } from "~~/server/core/insightsReel";
import { parseYear } from "~~/server/utils/insightsPeriod";
import { requireAuthTokenAllowQuery } from "~~/server/utils/requireAuth";

defineRouteMeta({
    openAPI: {
        description: "Download the requesting user's rendered highlight-reel MP4 for a year. Only ever serves the caller's own reel - the file path is derived from the authenticated user ID, never from a parameter. Accepts `?token=` so a <video> element can load it directly.",
        tags: ["insights"],
        operationId: "getHighlightReelVideo",
        parameters: [
            { name: "year", in: "path", required: true, schema: { type: "integer" } },
            { name: "token", in: "query", required: false, description: "Auth token, for clients that can't set the Authorization header", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "The MP4", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No reel has been rendered for that year", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthTokenAllowQuery(event);
    const year = parseYear(getRouterParam(event, "year"));

    const snapshot = await getYearSnapshot(userId, year);
    if (!snapshot?.hasReel) {
        throw createError({ statusCode: 404, statusMessage: "No reel available for that year" });
    }

    // SECURITY: built from the authenticated user's ID and a validated integer year, then re-checked against
    // the reel directory inside reelFilePath. The stored reel_path column is never used to open a file - it
    // exists as a record, not as an instruction.
    const path = reelFilePath(userId, year);

    let size: number;
    try {
        size = statSync(path).size;
    } catch {
        throw createError({ statusCode: 404, statusMessage: "No reel available for that year" });
    }

    setResponseHeader(event, "Content-Type", "video/mp4");
    setResponseHeader(event, "Content-Length", size);
    setResponseHeader(event, "Content-Disposition", `attachment; filename="nafyn-${year}.mp4"`);
    // personal media; must not be held by a shared cache
    setResponseHeader(event, "Cache-Control", "private, no-store");

    return sendStream(event, createReadStream(path));
});
