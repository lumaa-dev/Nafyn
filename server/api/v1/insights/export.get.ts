// personal data export: everything the insights feature holds about the requesting user.
import { getEventsForExport, countEventsForUser } from "~~/server/core/playEvents";
import { getInsightSettings } from "~~/server/core/insightsSettings";
import { listYearSnapshots } from "~~/server/core/insightsSnapshot";
import { listReplayYears, getReplayMix } from "~~/server/core/replayMix";
import { getLibrariesDb } from "~~/server/core/db";

// events are read in pages so a heavy listener's export doesn't materialize hundreds of thousands of rows at
// once; the response itself is still a single JSON document, which is what makes it portable
const PAGE_SIZE = 5_000;
const MAX_EVENTS = 500_000;

defineRouteMeta({
    openAPI: {
        description: "Full export of the requesting user's listening data: raw play events, aggregates, Replay Mixes and year-end snapshots, as a downloadable JSON document. Always scoped to the caller - there is no parameter for exporting anyone else's history.",
        tags: ["insights"],
        operationId: "exportInsightsData",
        responses: {
            "200": {
                description: "JSON attachment",
                content: { "application/json": { schema: { type: "object", description: "See `format` in the response body for the shape version" } } }
            },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

async function allRows(table: string, userId: string): Promise<unknown[]> {
    // table names come from the hard-coded list at the call site below, never from a request
    return await getLibrariesDb().prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(userId);
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const totalEvents = await countEventsForUser(userId);

    const events: unknown[] = [];
    for (let offset = 0; offset < Math.min(totalEvents, MAX_EVENTS); offset += PAGE_SIZE) {
        events.push(...await getEventsForExport(userId, PAGE_SIZE, offset));
    }

    const [settings, snapshots, replayYears] = await Promise.all([
        getInsightSettings(userId),
        listYearSnapshots(userId),
        listReplayYears(userId)
    ]);

    const replayMixes = await Promise.all(replayYears.map((r) => getReplayMix(userId, r.year)));

    const [daily, hourly, monthly, yearly] = await Promise.all([
        allRows("user_entity_stats_daily", userId),
        allRows("user_hour_stats_daily", userId),
        allRows("user_entity_stats_monthly", userId),
        allRows("user_entity_stats_yearly", userId)
    ]);

    setResponseHeader(event, "Content-Type", "application/json; charset=utf-8");
    // date-stamped so repeated exports don't overwrite each other in the browser's downloads folder
    const stamp = new Date().toISOString().slice(0, 10);
    setResponseHeader(event, "Content-Disposition", `attachment; filename="nafyn-listening-history-${stamp}.json"`);
    // an export is personal data; no cache, no store, anywhere along the way
    setResponseHeader(event, "Cache-Control", "no-store");

    return {
        format: "nafyn-insights-export/1",
        exportedAt: Date.now(),
        userId,
        settings,
        counts: {
            playEvents: totalEvents,
            playEventsIncluded: events.length,
            truncated: totalEvents > MAX_EVENTS
        },
        playEvents: events,
        aggregates: { daily, hourly, monthly, yearly },
        replayMixes,
        yearSnapshots: snapshots
    };
});
