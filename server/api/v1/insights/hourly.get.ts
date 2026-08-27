import { getInsightSettings } from "~~/server/core/insightsSettings";
import { getHourHistogram } from "~~/server/core/insightsQuery";
import {
    isPeriodKind, parseIsoWeek, parseMonth, parseYear,
    isoWeekBounds, monthBounds, yearBounds, localIsoWeek, localParts,
    PERIOD_KINDS
} from "~~/server/utils/insightsPeriod";

defineRouteMeta({
    openAPI: {
        description: "Tracks played and minutes listened per hour of day, for the requesting user. Always returns 24 points. Hours are the user's local time, fixed when the data was rolled up, so travelling doesn't retroactively redistribute past listening.",
        tags: ["insights"],
        operationId: "getHourlyInsights",
        parameters: [
            { name: "period", in: "query", required: false, description: "Time window; `all` covers every year with data. Defaults to `year`.", schema: { type: "string", enum: [...PERIOD_KINDS] } },
            { name: "week", in: "query", required: false, schema: { type: "string" } },
            { name: "month", in: "query", required: false, schema: { type: "string" } },
            { name: "year", in: "query", required: false, schema: { type: "integer" } }
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/HourPoint" } } } } },
            "400": { description: "Malformed period", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const { tzOffsetMinutes } = await getInsightSettings(userId);

    const query = getQuery(event);
    const period = query.period ?? "year";
    if (!isPeriodKind(period)) {
        throw createError({ statusCode: 400, statusMessage: `\`period\` must be one of: ${PERIOD_KINDS.join(", ")}` });
    }

    const local = localParts(Date.now(), tzOffsetMinutes);
    let startMs: number;
    let endMs: number;

    if (period === "week") {
        const { year, week } = query.week ? parseIsoWeek(query.week) : localIsoWeek(Date.now(), tzOffsetMinutes);
        ({ startMs, endMs } = isoWeekBounds(year, week, tzOffsetMinutes));
    } else if (period === "month") {
        const { year, month } = query.month ? parseMonth(query.month) : { year: local.year, month: local.month };
        ({ startMs, endMs } = monthBounds(year, month, tzOffsetMinutes));
    } else if (period === "year") {
        const year = query.year ? parseYear(query.year) : local.year;
        ({ startMs, endMs } = yearBounds(year, tzOffsetMinutes));
    } else {
        // "all": a window wide enough to cover anything the DATE columns can hold
        ({ startMs } = yearBounds(1970, tzOffsetMinutes));
        ({ endMs } = yearBounds(local.year + 1, tzOffsetMinutes));
    }

    return await getHourHistogram(userId, startMs, endMs);
});
