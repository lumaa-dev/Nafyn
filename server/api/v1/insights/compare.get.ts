import { getMultiYearComparison, getYearsWithData } from "~~/server/core/insightsQuery";
import { parseYear } from "~~/server/utils/insightsPeriod";

// each year costs a handful of grouped queries, so the list is capped rather than left open
const MAX_YEARS = 5;

defineRouteMeta({
    openAPI: {
        description: "Side-by-side totals for several years of the requesting user's listening, including minutes per month so two years can be overlaid on one chart. Defaults to the most recent years with data.",
        tags: ["insights"],
        operationId: "compareInsightsYears",
        parameters: [
            { name: "years", in: "query", required: false, description: `Comma-separated four-digit years, at most ${MAX_YEARS}. Defaults to the ${MAX_YEARS} most recent years with data.`, schema: { type: "string", example: "2024,2025,2026" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "array",
                            items: {
                                type: "object",
                                required: ["year", "totalMinutes", "totalPlays", "uniqueTracks", "uniqueAlbums", "uniqueArtists", "monthlyMinutes"],
                                properties: {
                                    year: { type: "integer" },
                                    totalMinutes: { type: "integer" },
                                    totalPlays: { type: "integer" },
                                    uniqueTracks: { type: "integer" },
                                    uniqueAlbums: { type: "integer" },
                                    uniqueArtists: { type: "integer" },
                                    monthlyMinutes: { type: "array", items: { type: "integer" }, description: "12 entries, January first" }
                                }
                            }
                        }
                    }
                }
            },
            "400": { description: "Malformed or too many years", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const query = getQuery(event);

    let years: number[];

    if (typeof query.years === "string" && query.years.trim()) {
        const parts = query.years.split(",").map((p) => p.trim()).filter(Boolean);
        if (parts.length > MAX_YEARS) {
            throw createError({ statusCode: 400, statusMessage: `At most ${MAX_YEARS} years` });
        }
        years = [...new Set(parts.map(parseYear))];
    } else {
        years = (await getYearsWithData(userId)).slice(0, MAX_YEARS);
    }

    // ascending, so a chart's series order matches the legend's reading order
    years.sort((a, b) => a - b);

    return await getMultiYearComparison(userId, years);
});
