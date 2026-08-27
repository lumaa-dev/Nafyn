// typed fetch wrappers for the /api/v1/insights endpoints.
//
// One place that knows the routes and the auth header, so the pages stay about layout. Every call is scoped
// to the authenticated user server-side; none of these takes a user id, because none of the endpoints does.
import type { RankedEntity } from "~/components/insights/TopEntityList.vue";
import type { Gate } from "~/components/insights/EnoughDataGate.vue";
import type { HourPoint } from "~/components/charts/HourHistogram.vue";
import type { MediaRow } from "~~/server/core/library";

export type EntityType = "track" | "album" | "artist" | "playlist";

export interface PeriodTotals {
    totalMinutes: number,
    totalPlays: number,
    uniqueTracks: number,
    uniqueAlbums: number,
    uniqueArtists: number,
    uniquePlaylists: number,
    longestStreakDays?: number
}

export interface DayPoint { date: string, minutes: number, plays: number }

export interface WeeklyInsights {
    week: string,
    previousWeek: string,
    totals: PeriodTotals,
    previousTotals: PeriodTotals,
    series: DayPoint[],
    previousSeries: DayPoint[],
    top: Record<EntityType, RankedEntity[]>,
    gate: Gate
}

export interface MonthlyInsights {
    month: string,
    previousMonth: string,
    totals: PeriodTotals,
    previousTotals: PeriodTotals,
    series: DayPoint[],
    hourHistogram: HourPoint[],
    top: Record<EntityType, RankedEntity[]>,
    gate: Gate
}

export interface YearlyInsights {
    year: number,
    snapshot: boolean,
    snapshotCreatedAt: number | null,
    reelStatus: "none" | "queued" | "rendering" | "ready" | "failed",
    totals: PeriodTotals,
    monthlyMinutes: number[],
    hourHistogram: HourPoint[],
    top: Record<EntityType, RankedEntity[]>,
    availableYears: number[],
    gate: Gate
}

export interface YearComparison {
    year: number,
    totalMinutes: number,
    totalPlays: number,
    uniqueTracks: number,
    uniqueAlbums: number,
    uniqueArtists: number,
    monthlyMinutes: number[]
}

export interface ReplayEntry {
    position: number,
    trackId: string,
    playCount: number,
    minutes: number,
    title: string | null,
    subtitle: string | null,
    cover: string | null,
    available: boolean,
    media: MediaRow | null
}

export interface ReplayMix {
    id: string,
    year: number,
    isAllTime: boolean,
    refreshedAt: number | null,
    entries: ReplayEntry[],
    archive: { year: number, id: string, trackCount: number, refreshedAt: number | null }[]
}

export interface ReelSlide {
    kind: "intro" | "stat" | "track" | "artist" | "outro",
    label?: string | null,
    value?: string | null,
    title?: string | null,
    subtitle?: string | null,
    cover?: string | null,
    trackId?: string | null,
    excerptStartSeconds?: number | null,
    excerptSeconds?: number | null
}

export interface HighlightReel {
    year: number,
    slides: ReelSlide[],
    collage: string[],
    reelStatus: "none" | "queued" | "rendering" | "ready" | "failed",
    reelError: string | null,
    hasVideo: boolean
}

export function useInsights() {
    // the cookie already carries the "Bearer " prefix (set that way at login), so it is passed verbatim
    const token = useCookie("nafynToken").value ?? "";
    const auth = { Authorization: token };

    return {
        token,

        weekly: (week?: string) =>
            $fetch<WeeklyInsights>("/api/v1/insights/summary/weekly", { headers: auth, query: week ? { week } : {} }),

        monthly: (month?: string) =>
            $fetch<MonthlyInsights>("/api/v1/insights/summary/monthly", { headers: auth, query: month ? { month } : {} }),

        yearly: (year?: number) =>
            $fetch<YearlyInsights>("/api/v1/insights/summary/yearly", { headers: auth, query: year ? { year } : {} }),

        top: (params: { type: EntityType, period: "week" | "month" | "year" | "all", page?: number, limit?: number, week?: string, month?: string, year?: number }) =>
            $fetch<{ items: RankedEntity[], page: number, limit: number, total: number, hasMore: boolean }>("/api/v1/insights/top", { headers: auth, query: params }),

        hourly: (params: { period?: "week" | "month" | "year" | "all", year?: number, month?: string, week?: string } = {}) =>
            $fetch<HourPoint[]>("/api/v1/insights/hourly", { headers: auth, query: params }),

        compare: (years?: number[]) =>
            $fetch<YearComparison[]>("/api/v1/insights/compare", { headers: auth, query: years?.length ? { years: years.join(",") } : {} }),

        replay: () => $fetch<ReplayMix>("/api/v1/insights/replay", { headers: auth }),

        // `year` accepts a four-digit year or the literal "all-time"
        replayYear: (year: number | "all-time") => $fetch<ReplayMix>(`/api/v1/insights/replay/${year}`, { headers: auth }),

        reel: (year: number) => $fetch<HighlightReel>(`/api/v1/insights/reel/${year}`, { headers: auth }),

        requestReelVideo: (year: number) =>
            $fetch<{ reelStatus: string }>(`/api/v1/insights/reel/${year}`, { method: "POST", headers: auth }),

        reelVideoUrl: (year: number) =>
            `/api/v1/insights/reel/${year}/asset?token=${encodeURIComponent(token)}`,

        exportUrl: () => `/api/v1/insights/export`,

        deleteHistory: () => $fetch<{ deleted: boolean }>("/api/v1/insights/history", { method: "DELETE", headers: auth })
    };
}
