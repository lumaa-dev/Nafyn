// time-window parsing and bucketing for listening insights.
//
// SECURITY: this module is the only place a caller-supplied period string is allowed to be interpreted.
// Every function either returns a validated number/tuple or throws a 400, and every dynamic fragment that
// reaches SQL (entity types, sort columns, bucket tables) comes from one of the frozen tuples below rather
// than from a request. Nothing here ever concatenates user input into a query.
//
// Time zones: play_events stores UTC (the pool is pinned to "Z"), but a user's "day", "week", "month" and
// "year" are local to them. Everything below works by shifting a UTC instant by the user's stored offset and
// then reading UTC calendar parts off the shifted value - `localMs = utcMs + tzOffsetMinutes * 60000` - so
// there is exactly one conversion rule in the codebase instead of one per query.

export const ENTITY_TYPES = ["track", "album", "artist", "playlist"] as const;
export type EntityType = typeof ENTITY_TYPES[number];

// mirrors the ENUM on play_events.source. Kept in sync by hand: MySQL silently coerces an out-of-list value
// to '' under a non-strict sql_mode, so validating against this tuple is what stops a bad source from
// becoming an invisible empty-string bucket.
export const PLAY_SOURCES = ["library", "playlist", "album", "track"] as const;
export type PlaySource = typeof PLAY_SOURCES[number];

export const PERIOD_KINDS = ["week", "month", "year", "all"] as const;
export type PeriodKind = typeof PERIOD_KINDS[number];

export function isEntityType(value: unknown): value is EntityType {
    return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}

export function isPlaySource(value: unknown): value is PlaySource {
    return typeof value === "string" && (PLAY_SOURCES as readonly string[]).includes(value);
}

export function isPeriodKind(value: unknown): value is PeriodKind {
    return typeof value === "string" && (PERIOD_KINDS as readonly string[]).includes(value);
}

export interface Bounds {
    /** inclusive start, epoch ms UTC */
    startMs: number,
    /** exclusive end, epoch ms UTC */
    endMs: number
}

const DAY_MS = 86_400_000;
const MIN_YEAR = 1970;
// TIMESTAMP tops out in 2038; refusing anything past it here turns a silent out-of-range write into a 400
const MAX_YEAR = 2037;

function bad(what: string): never {
    throw createError({ statusCode: 400, statusMessage: `Invalid ${what}` });
}

export function parseYear(value: unknown): number {
    const year = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) bad("year");
    return year;
}

export function parseMonth(value: unknown): { year: number, month: number } {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? "").trim());
    if (!match) bad("month (expected YYYY-MM)");
    const year = parseYear(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) bad("month (expected YYYY-MM)");
    return { year, month };
}

export function parseIsoWeek(value: unknown): { year: number, week: number } {
    const match = /^(\d{4})-W(\d{2})$/.exec(String(value ?? "").trim());
    if (!match) bad("week (expected YYYY-Www)");
    const year = parseYear(match[1]);
    const week = Number(match[2]);
    if (week < 1 || week > 53) bad("week (expected YYYY-Www)");
    return { year, week };
}

// --- local-calendar helpers -------------------------------------------------------------------------

/** epoch ms of the start of the local day containing `utcMs`, for a user at `tzOffsetMinutes` */
export function startOfLocalDay(utcMs: number, tzOffsetMinutes: number): number {
    const local = utcMs + tzOffsetMinutes * 60_000;
    const floored = Math.floor(local / DAY_MS) * DAY_MS;
    return floored - tzOffsetMinutes * 60_000;
}

/** local calendar parts (year, month 1-12, day, weekday 0=Sunday, hour) of a UTC instant */
export function localParts(utcMs: number, tzOffsetMinutes: number) {
    const d = new Date(utcMs + tzOffsetMinutes * 60_000);
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        weekday: d.getUTCDay(),
        hour: d.getUTCHours()
    };
}

/** "YYYY-MM-DD" in the user's local calendar - the value stored in user_entity_stats_daily.bucket_date */
export function localDateKey(utcMs: number, tzOffsetMinutes: number): string {
    const { year, month, day } = localParts(utcMs, tzOffsetMinutes);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** parses a "YYYY-MM-DD" bucket key back to the UTC instant its local day starts at */
export function dateKeyToBounds(dateKey: string, tzOffsetMinutes: number): Bounds {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    if (!match) bad("date (expected YYYY-MM-DD)");
    const startMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - tzOffsetMinutes * 60_000;
    return { startMs, endMs: startMs + DAY_MS };
}

export function monthBounds(year: number, month: number, tzOffsetMinutes: number): Bounds {
    const startMs = Date.UTC(year, month - 1, 1) - tzOffsetMinutes * 60_000;
    const endMs = Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1) - tzOffsetMinutes * 60_000;
    return { startMs, endMs };
}

export function yearBounds(year: number, tzOffsetMinutes: number): Bounds {
    return {
        startMs: Date.UTC(year, 0, 1) - tzOffsetMinutes * 60_000,
        endMs: Date.UTC(year + 1, 0, 1) - tzOffsetMinutes * 60_000
    };
}

// ISO-8601 weeks: Monday-based, and week 1 is the one containing the year's first Thursday. Nafyn surfaces
// "available every Monday", so the whole weekly feature hinges on this being the ISO definition rather than
// a naive "day 0 = Sunday" one.
export function isoWeekBounds(year: number, week: number, tzOffsetMinutes: number): Bounds {
    // Jan 4th is always in ISO week 1
    const jan4 = Date.UTC(year, 0, 4);
    const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7; // 0 = Monday
    const week1Monday = jan4 - jan4Weekday * DAY_MS;
    const startUtcMidnight = week1Monday + (week - 1) * 7 * DAY_MS;
    const startMs = startUtcMidnight - tzOffsetMinutes * 60_000;
    return { startMs, endMs: startMs + 7 * DAY_MS };
}

/** the ISO year+week a UTC instant falls in, in the user's local calendar */
export function localIsoWeek(utcMs: number, tzOffsetMinutes: number): { year: number, week: number } {
    const local = new Date(utcMs + tzOffsetMinutes * 60_000);
    // shift to the Thursday of this week; that Thursday's calendar year *is* the ISO week-year, which is why
    // the last days of December can legitimately belong to week 1 of the next year (and vice versa)
    const weekday = (local.getUTCDay() + 6) % 7;
    const thursday = new Date(local.getTime() + (3 - weekday) * DAY_MS);
    const year = thursday.getUTCFullYear();
    const jan4 = Date.UTC(year, 0, 4);
    const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7;
    const week1Monday = jan4 - jan4Weekday * DAY_MS;
    const week = Math.floor((thursday.getTime() - week1Monday) / (7 * DAY_MS)) + 1;
    return { year, week };
}

export function formatIsoWeek(year: number, week: number): string {
    return `${year}-W${String(week).padStart(2, "0")}`;
}

/** the ISO week immediately before the given one, handling the 52/53-week year boundary */
export function previousIsoWeek(year: number, week: number, tzOffsetMinutes: number): { year: number, week: number } {
    const { startMs } = isoWeekBounds(year, week, tzOffsetMinutes);
    return localIsoWeek(startMs - DAY_MS, tzOffsetMinutes);
}

export function previousMonth(year: number, month: number): { year: number, month: number } {
    return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

// --- MySQL literal formatting -----------------------------------------------------------------------

/**
 * epoch ms -> "YYYY-MM-DD HH:MM:SS.mmm" in UTC, for binding to a TIMESTAMP(3) column.
 *
 * Bound as a string rather than a JS Date deliberately: mysql2 serializes a Date using the pool's timezone
 * setting, and a string leaves nothing to interpret. The pool is pinned to "Z", so both paths agree today -
 * this just removes the possibility that they ever stop agreeing.
 */
export function toMysqlDateTime(ms: number): string {
    return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
}

/** epoch ms -> "YYYY-MM-DD" in UTC, for binding to a DATE column */
export function toMysqlDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

export { DAY_MS };
