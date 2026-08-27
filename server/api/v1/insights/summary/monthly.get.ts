import { getInsightSettings } from "~~/server/core/insightsSettings";
import { getBucketTotals, getTopEntitiesForBucket, getHourHistogram, getLongestStreak, getDailySeries, hasEnoughData } from "~~/server/core/insightsQuery";
import { monthBounds, previousMonth, parseMonth, localParts, type EntityType } from "~~/server/utils/insightsPeriod";

const TOP_N = 10;

defineRouteMeta({
    openAPI: {
        description: "Monthly listening summary for the requesting user, with the previous month's totals for comparison. Months are the user's local calendar months. Defaults to the month in progress.",
        tags: ["insights"],
        operationId: "getMonthlyInsights",
        parameters: [
            { name: "month", in: "query", required: false, description: "`YYYY-MM`. Defaults to the current month.", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthlyInsights" } } } },
            "400": { description: "Malformed month", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    HourPoint: {
                        type: "object",
                        required: ["hour", "plays", "minutes"],
                        properties: {
                            hour: { type: "integer", minimum: 0, maximum: 23, description: "Hour of day in the user's local time, fixed at rollup" },
                            plays: { type: "integer" },
                            minutes: { type: "integer" }
                        }
                    },
                    MonthlyInsights: {
                        type: "object",
                        required: ["month", "previousMonth", "totals", "previousTotals", "series", "hourHistogram", "top", "gate"],
                        properties: {
                            month: { type: "string", example: "2026-08" },
                            previousMonth: { type: "string" },
                            totals: { $ref: "#/components/schemas/PeriodTotals" },
                            previousTotals: { $ref: "#/components/schemas/PeriodTotals" },
                            series: { type: "array", items: { $ref: "#/components/schemas/DayPoint" } },
                            hourHistogram: { type: "array", items: { $ref: "#/components/schemas/HourPoint" } },
                            top: {
                                type: "object",
                                properties: {
                                    track: { type: "array", items: { $ref: "#/components/schemas/RankedEntity" } },
                                    album: { type: "array", items: { $ref: "#/components/schemas/RankedEntity" } },
                                    artist: { type: "array", items: { $ref: "#/components/schemas/RankedEntity" } },
                                    playlist: { type: "array", items: { $ref: "#/components/schemas/RankedEntity" } }
                                }
                            },
                            gate: { $ref: "#/components/schemas/EnoughDataGate" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const { tzOffsetMinutes } = await getInsightSettings(userId);

    const query = getQuery(event);
    const local = localParts(Date.now(), tzOffsetMinutes);
    const { year, month } = query.month ? parseMonth(query.month) : { year: local.year, month: local.month };

    const bounds = monthBounds(year, month, tzOffsetMinutes);
    const prior = previousMonth(year, month);

    const [totals, previousTotals, series, hourHistogram, streak, gate] = await Promise.all([
        getBucketTotals(userId, "monthly", { year, month }),
        getBucketTotals(userId, "monthly", { year: prior.year, month: prior.month }),
        getDailySeries(userId, bounds.startMs, bounds.endMs),
        getHourHistogram(userId, bounds.startMs, bounds.endMs),
        getLongestStreak(userId, bounds.startMs, bounds.endMs),
        hasEnoughData(userId, bounds.startMs, bounds.endMs)
    ]);

    const top = {} as Record<EntityType, unknown>;
    for (const entityType of ["track", "album", "artist", "playlist"] as EntityType[]) {
        top[entityType] = await getTopEntitiesForBucket(userId, "monthly", { year, month }, entityType, TOP_N, 0);
    }

    return {
        month: `${year}-${String(month).padStart(2, "0")}`,
        previousMonth: `${prior.year}-${String(prior.month).padStart(2, "0")}`,
        totals: { ...totals, longestStreakDays: streak },
        previousTotals,
        series,
        hourHistogram,
        top,
        gate
    };
});
