import { getInsightSettings } from "~~/server/core/insightsSettings";
import { getBucketTotals, getTopEntitiesForBucket, getHourHistogram, getLongestStreak, getMultiYearComparison, getYearsWithData, hasEnoughData } from "~~/server/core/insightsQuery";
import { getYearSnapshot } from "~~/server/core/insightsSnapshot";
import { yearBounds, parseYear, localParts, type EntityType } from "~~/server/utils/insightsPeriod";

const TOP_N = 25;

defineRouteMeta({
    openAPI: {
        description: "Yearly listening summary for the requesting user. Live from the aggregates all year; once the year-end snapshot has been taken (start of December) the frozen copy is returned instead, so a shared year-end package never rewrites itself later.",
        tags: ["insights"],
        operationId: "getYearlyInsights",
        parameters: [
            { name: "year", in: "query", required: false, description: "Four-digit year. Defaults to the current year.", schema: { type: "integer" } }
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/YearlyInsights" } } } },
            "400": { description: "Malformed year", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    YearlyInsights: {
                        type: "object",
                        required: ["year", "snapshot", "totals", "monthlyMinutes", "hourHistogram", "top", "availableYears", "gate"],
                        properties: {
                            year: { type: "integer" },
                            snapshot: { type: "boolean", description: "True when this is the frozen year-end copy rather than a live computation" },
                            snapshotCreatedAt: { type: "integer", format: "int64", nullable: true },
                            reelStatus: { type: "string", enum: ["none", "queued", "rendering", "ready", "failed"] },
                            totals: { $ref: "#/components/schemas/PeriodTotals" },
                            monthlyMinutes: { type: "array", items: { type: "integer" }, description: "12 entries, January first" },
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
                            availableYears: { type: "array", items: { type: "integer" }, description: "Years the user has any data for, newest first" },
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
    const year = query.year ? parseYear(query.year) : localParts(Date.now(), tzOffsetMinutes).year;

    const bounds = yearBounds(year, tzOffsetMinutes);
    const [availableYears, gate, snapshot] = await Promise.all([
        getYearsWithData(userId),
        hasEnoughData(userId, bounds.startMs, bounds.endMs),
        getYearSnapshot(userId, year)
    ]);

    // a frozen year is served verbatim: it is the record of what that year looked like, not a view onto
    // aggregates that have kept moving
    if (snapshot) {
        return {
            year,
            snapshot: true,
            snapshotCreatedAt: snapshot.createdAt,
            reelStatus: snapshot.reelStatus,
            totals: snapshot.payload.totals,
            monthlyMinutes: snapshot.payload.monthlyMinutes,
            hourHistogram: snapshot.payload.hourHistogram,
            top: snapshot.payload.top,
            availableYears,
            gate
        };
    }

    const [totals, hourHistogram, streak, comparison] = await Promise.all([
        getBucketTotals(userId, "yearly", { year }),
        getHourHistogram(userId, bounds.startMs, bounds.endMs),
        getLongestStreak(userId, bounds.startMs, bounds.endMs),
        getMultiYearComparison(userId, [year])
    ]);

    const top = {} as Record<EntityType, unknown>;
    for (const entityType of ["track", "album", "artist", "playlist"] as EntityType[]) {
        top[entityType] = await getTopEntitiesForBucket(userId, "yearly", { year }, entityType, TOP_N, 0);
    }

    return {
        year,
        snapshot: false,
        snapshotCreatedAt: null,
        reelStatus: "none",
        totals: { ...totals, longestStreakDays: streak },
        monthlyMinutes: comparison[0]?.monthlyMinutes ?? Array(12).fill(0),
        hourHistogram,
        top,
        availableYears,
        gate
    };
});
