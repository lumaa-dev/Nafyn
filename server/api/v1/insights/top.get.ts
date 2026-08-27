import { getInsightSettings } from "~~/server/core/insightsSettings";
import {
    getTopEntitiesForBucket, countEntitiesForBucket, getTopEntitiesForRange,
    getAllTimeTop, countAllTime
} from "~~/server/core/insightsQuery";
import { parsePagination, paginated, paginationQueryParams, paginatedResponseSchema } from "~~/server/utils/pagination";
import {
    isEntityType, isPeriodKind, parseIsoWeek, parseMonth, parseYear,
    isoWeekBounds, localIsoWeek, localParts,
    ENTITY_TYPES, PERIOD_KINDS
} from "~~/server/utils/insightsPeriod";

defineRouteMeta({
    openAPI: {
        description: "Full ranked list of the requesting user's top tracks, albums, artists or playlists for a period, paginated. Month and year periods read precomputed ranks; week and all-time are computed on the fly.",
        tags: ["insights"],
        operationId: "getTopEntities",
        parameters: [
            { name: "type", in: "query", required: true, description: "Entity to rank", schema: { type: "string", enum: [...ENTITY_TYPES] } },
            { name: "period", in: "query", required: true, description: "Time window", schema: { type: "string", enum: [...PERIOD_KINDS] } },
            { name: "week", in: "query", required: false, description: "`YYYY-Www`, when period is `week`. Defaults to the current week.", schema: { type: "string" } },
            { name: "month", in: "query", required: false, description: "`YYYY-MM`, when period is `month`. Defaults to the current month.", schema: { type: "string" } },
            { name: "year", in: "query", required: false, description: "Four-digit year, when period is `year`. Defaults to the current year.", schema: { type: "integer" } },
            ...paginationQueryParams
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: paginatedResponseSchema("#/components/schemas/RankedEntity") } } },
            "400": { description: "Unknown `type` or `period`, or a malformed period value", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const { tzOffsetMinutes } = await getInsightSettings(userId);

    const query = getQuery(event);
    const pagination = parsePagination(event);

    // SECURITY: both of these are checked against frozen tuples before anything downstream picks a table or
    // a predicate from them. Neither value is ever concatenated into SQL.
    if (!isEntityType(query.type)) {
        throw createError({ statusCode: 400, statusMessage: `\`type\` must be one of: ${ENTITY_TYPES.join(", ")}` });
    }
    if (!isPeriodKind(query.period)) {
        throw createError({ statusCode: 400, statusMessage: `\`period\` must be one of: ${PERIOD_KINDS.join(", ")}` });
    }

    const entityType = query.type;

    if (query.period === "all") {
        const [items, total] = await Promise.all([
            getAllTimeTop(userId, entityType, pagination.limit, pagination.offset),
            countAllTime(userId, entityType)
        ]);
        return paginated(items, total, pagination);
    }

    if (query.period === "week") {
        const { year, week } = query.week ? parseIsoWeek(query.week) : localIsoWeek(Date.now(), tzOffsetMinutes);
        const { startMs, endMs } = isoWeekBounds(year, week, tzOffsetMinutes);

        // a week has no bucket table, so the whole window is scored and then sliced. Seven days of daily rows
        // is small enough that paging in JS costs less than materializing a weekly aggregate would.
        const all = await getTopEntitiesForRange(userId, entityType, startMs, endMs, Number.MAX_SAFE_INTEGER);
        return paginated(all.slice(pagination.offset, pagination.offset + pagination.limit), all.length, pagination);
    }

    if (query.period === "month") {
        const local = localParts(Date.now(), tzOffsetMinutes);
        const { year, month } = query.month ? parseMonth(query.month) : { year: local.year, month: local.month };
        const [items, total] = await Promise.all([
            getTopEntitiesForBucket(userId, "monthly", { year, month }, entityType, pagination.limit, pagination.offset),
            countEntitiesForBucket(userId, "monthly", { year, month }, entityType)
        ]);
        return paginated(items, total, pagination);
    }

    const year = query.year ? parseYear(query.year) : localParts(Date.now(), tzOffsetMinutes).year;

    const [items, total] = await Promise.all([
        getTopEntitiesForBucket(userId, "yearly", { year }, entityType, pagination.limit, pagination.offset),
        countEntitiesForBucket(userId, "yearly", { year }, entityType)
    ]);
    return paginated(items, total, pagination);
});
