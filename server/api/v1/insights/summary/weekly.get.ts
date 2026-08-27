import { getInsightSettings } from "~~/server/core/insightsSettings";
import { getRangeTotals, getTopEntitiesForRange, getDailySeries, hasEnoughData } from "~~/server/core/insightsQuery";
import { isoWeekBounds, localIsoWeek, previousIsoWeek, parseIsoWeek, formatIsoWeek, type EntityType } from "~~/server/utils/insightsPeriod";

const TOP_N = 10;

defineRouteMeta({
    openAPI: {
        description: "Weekly listening summary for the requesting user, with the previous week alongside it for comparison. Weeks are ISO-8601 (Monday-based) in the user's own time zone. Defaults to the week in progress.",
        tags: ["insights"],
        operationId: "getWeeklyInsights",
        parameters: [
            { name: "week", in: "query", required: false, description: "ISO week, e.g. `2026-W35`. Defaults to the current week.", schema: { type: "string" } }
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/WeeklyInsights" } } } },
            "400": { description: "Malformed week", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    RankedEntity: {
                        type: "object",
                        required: ["entityType", "entityId", "rank", "score", "playCount", "totalDurationMs", "minutes"],
                        properties: {
                            entityType: { type: "string", enum: ["track", "album", "artist", "playlist"] },
                            entityId: { type: "string", description: "Media ID for tracks, release-group MBID for albums, artist MBID (or name) for artists, playlist ID for playlists" },
                            rank: { type: "integer", description: "1-based rank within the period" },
                            score: { type: "number", description: "(alpha x normalized plays) + (beta x normalized time) + (gamma x recency decay)" },
                            playCount: { type: "integer" },
                            totalDurationMs: { type: "integer", format: "int64" },
                            minutes: { type: "integer" },
                            firstPlayedAt: { type: "integer", format: "int64", nullable: true },
                            lastPlayedAt: { type: "integer", format: "int64", nullable: true },
                            isFirstEver: { type: "boolean", description: "The user heard this for the first time in this period" },
                            title: { type: "string", nullable: true, description: "Snapshot taken at rollup, so entries survive the track leaving the library" },
                            subtitle: { type: "string", nullable: true },
                            cover: { type: "string", nullable: true }
                        }
                    },
                    PeriodTotals: {
                        type: "object",
                        required: ["totalMinutes", "totalPlays", "uniqueTracks", "uniqueAlbums", "uniqueArtists", "uniquePlaylists"],
                        properties: {
                            totalMinutes: { type: "integer", description: "Wall-clock minutes actually played" },
                            totalPlays: { type: "integer" },
                            uniqueTracks: { type: "integer" },
                            uniqueAlbums: { type: "integer" },
                            uniqueArtists: { type: "integer" },
                            uniquePlaylists: { type: "integer" },
                            longestStreakDays: { type: "integer", description: "Longest run of consecutive days with any listening" }
                        }
                    },
                    EnoughDataGate: {
                        type: "object",
                        required: ["enough", "uniqueTracks", "minutes", "needUniqueTracks", "needMinutes"],
                        properties: {
                            enough: { type: "boolean", description: "False means the client should show the 'keep listening' state instead of any ranking" },
                            uniqueTracks: { type: "integer" },
                            minutes: { type: "integer" },
                            needUniqueTracks: { type: "integer" },
                            needMinutes: { type: "integer" }
                        }
                    },
                    DayPoint: {
                        type: "object",
                        required: ["date", "minutes", "plays"],
                        properties: {
                            date: { type: "string", format: "date" },
                            minutes: { type: "integer" },
                            plays: { type: "integer" }
                        }
                    },
                    WeeklyInsights: {
                        type: "object",
                        required: ["week", "previousWeek", "totals", "previousTotals", "series", "previousSeries", "top", "gate"],
                        properties: {
                            week: { type: "string", example: "2026-W35" },
                            previousWeek: { type: "string" },
                            totals: { $ref: "#/components/schemas/PeriodTotals" },
                            previousTotals: { $ref: "#/components/schemas/PeriodTotals" },
                            series: { type: "array", items: { $ref: "#/components/schemas/DayPoint" } },
                            previousSeries: { type: "array", items: { $ref: "#/components/schemas/DayPoint" } },
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
    const { year, week } = query.week ? parseIsoWeek(query.week) : localIsoWeek(Date.now(), tzOffsetMinutes);

    const current = isoWeekBounds(year, week, tzOffsetMinutes);
    const prior = previousIsoWeek(year, week, tzOffsetMinutes);
    const previous = isoWeekBounds(prior.year, prior.week, tzOffsetMinutes);

    const [totals, previousTotals, series, previousSeries, gate] = await Promise.all([
        getRangeTotals(userId, current.startMs, current.endMs),
        getRangeTotals(userId, previous.startMs, previous.endMs),
        getDailySeries(userId, current.startMs, current.endMs),
        getDailySeries(userId, previous.startMs, previous.endMs),
        hasEnoughData(userId, current.startMs, current.endMs)
    ]);

    const top = {} as Record<EntityType, unknown>;
    for (const entityType of ["track", "album", "artist", "playlist"] as EntityType[]) {
        top[entityType] = await getTopEntitiesForRange(userId, entityType, current.startMs, current.endMs, TOP_N);
    }

    return {
        week: formatIsoWeek(year, week),
        previousWeek: formatIsoWeek(prior.year, prior.week),
        totals,
        previousTotals,
        series,
        previousSeries,
        top,
        gate
    };
});
