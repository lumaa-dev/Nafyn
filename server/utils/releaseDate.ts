// "is this out yet?" for MusicBrainz release dates, plus the timezone arithmetic release subscriptions need.
//
// MusicBrainz dates are calendar dates with no time and no zone ("2026-11-20", or partial: "2026-11",
// "2027"). Music goes live at local midnight per storefront, so "released" is not one instant worldwide:
//   * the SERVER is lenient and calls a date released once it has started *anywhere* (UTC+14, the earliest
//     zone) - refusing a request someone in Auckland can already make would be the worse error;
//   * the UI and release notifications are exact per person: local midnight in their own timezone.
// A partial date is padded to its earliest day ("2027" -> 2027-01-01), the same reading parseReleaseDate()
// already gives it, so the album page's per-track `released` flag and this module never disagree.

export type ReleasePrecision = "day" | "month" | "year";

// UTC+14 (Line Islands) is the first place a calendar day starts
const EARLIEST_OFFSET_MS = 14 * 60 * 60 * 1000;

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** Normalizes a MusicBrainz date (full or partial) to `YYYY-MM-DD` plus how much of it was actually known. */
export function normalizeReleaseDate(raw: string | null | undefined): { date: string, precision: ReleasePrecision } | null {
    if (!raw) return null;
    const match = DATE_RE.exec(raw.trim());
    if (!match) return null;
    const [, year, month, day] = match;
    return {
        date: `${year}-${month ?? "01"}-${day ?? "01"}`,
        precision: day ? "day" : month ? "month" : "year"
    };
}

/** Same as normalizeReleaseDate, from the `Date` parseReleaseDate() produced (UTC midnight of the date). */
export function releaseDateFromDate(date: Date | null | undefined): string | null {
    if (!date || Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

/** true once `YYYY-MM-DD` has begun in the earliest timezone on Earth. No date means released (unknown is not upcoming). */
export function isReleased(date: string | Date | null | undefined, nowMs: number = Date.now()): boolean {
    const day = typeof date === "string" ? normalizeReleaseDate(date)?.date : releaseDateFromDate(date ?? null);
    if (!day) return true;
    return Date.parse(`${day}T00:00:00Z`) - EARLIEST_OFFSET_MS <= nowMs;
}

export function isValidTimeZone(tz: unknown): tz is string {
    if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

// offset (ms, local - UTC) of `timeZone` at instant `utcMs`, read back through Intl - no tz database dependency
function zoneOffsetMs(utcMs: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * UTC epoch-ms of 00:00 local time on `YYYY-MM-DD` in `timeZone`.
 * Two passes, because the offset at "UTC midnight" can differ from the offset at local midnight across a DST
 * change. A zone whose midnight doesn't exist that day (a DST jump at 00:00) lands on the first valid instant.
 */
export function localMidnightUtc(date: string, timeZone: string): number {
    const naive = Date.parse(`${date}T00:00:00Z`);
    let guess = naive - zoneOffsetMs(naive, timeZone);
    guess = naive - zoneOffsetMs(guess, timeZone);
    return guess;
}
