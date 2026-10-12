// GDPR art. 15 + art. 20: one downloadable document holding everything Nafyn keeps about the caller.
//
// Supersedes GET /api/v1/insights/export, which only ever covered listening data - that one stays for
// anyone who just wants their play history, but this is the one the privacy panel points at.
import { buildAccountExport } from "~~/server/core/accountExport";
import { consumeRateLimit } from "~~/server/utils/rateLimit";

// an export materializes a lot of rows in memory at once - fine on demand, not on repeat
const MAX_EXPORTS = 5;
const EXPORT_WINDOW_MS = 60 * 60 * 1000;

defineRouteMeta({
    openAPI: {
        description: "Full export of everything the instance holds about the requesting user: profile, settings, session/login metadata, credential metadata (never the secrets), library entries, playlists, download requests, recently played and all listening data. Always scoped to the caller - there is no parameter for exporting anyone else's account.",
        tags: ["user"],
        operationId: "exportAccountData",
        responses: {
            "200": {
                description: "JSON attachment",
                content: { "application/json": { schema: { type: "object", description: "See `format` in the response body for the shape version" } } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many exports", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    const rateLimit = consumeRateLimit(`account:export:${userId}`, MAX_EXPORTS, EXPORT_WINDOW_MS);
    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many exports, try again later" });
    }

    const data = await buildAccountExport(userId);

    setResponseHeader(event, "Content-Type", "application/json; charset=utf-8");
    // date-stamped so repeated exports don't overwrite each other in the browser's downloads folder
    const stamp = new Date().toISOString().slice(0, 10);
    setResponseHeader(event, "Content-Disposition", `attachment; filename="nafyn-account-data-${stamp}.json"`);
    // an export is personal data; no cache, no store, anywhere along the way
    setResponseHeader(event, "Cache-Control", "no-store");

    return data;
});
