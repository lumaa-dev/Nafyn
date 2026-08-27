import { getReplayMix, listReplayYears, ALL_TIME_YEAR } from "~~/server/core/replayMix";
import { parseYear } from "~~/server/utils/insightsPeriod";

defineRouteMeta({
    openAPI: {
        description: "An archived Replay Mix for the requesting user: a past year, or the All-Time mix. Archived years are never rebuilt - they are the mix as it stood at the end of that year. Read-only, like every Replay Mix.",
        tags: ["insights"],
        operationId: "getArchivedReplayMix",
        parameters: [
            { name: "year", in: "path", required: true, description: "Four-digit year, or the literal `all-time`", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/ReplayMix" } } } },
            "400": { description: "Malformed year", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const raw = getRouterParam(event, "year");
    const year = raw === "all-time" ? ALL_TIME_YEAR : parseYear(raw);

    const [mix, archive] = await Promise.all([
        // scoped to `sub`, never to a caller-supplied user - one user's mix is not readable by another
        getReplayMix(userId, year),
        listReplayYears(userId)
    ]);

    return { ...mix, archive };
});
