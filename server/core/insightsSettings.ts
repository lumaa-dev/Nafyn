// per-user listening-history opt-in.
//
// Kept in its own table (see insightsSchema.ts for why) and read on every ingest, so it is the single gate
// that decides whether a play event is allowed to exist at all.
import { getUsersDb } from "./db";

export interface InsightSettingsRow {
    user_id: string,
    history_enabled: number,
    enabled_at: Date | null,
    disabled_at: Date | null,
    tz_offset_minutes: number
}

export interface InsightSettings {
    historyEnabled: boolean,
    enabledAt: number | null,
    disabledAt: number | null,
    tzOffsetMinutes: number
}

function rowToSettings(row: InsightSettingsRow | undefined): InsightSettings {
    // no row means the user has never opted in - history is off
    if (!row) return { historyEnabled: false, enabledAt: null, disabledAt: null, tzOffsetMinutes: 0 };

    return {
        historyEnabled: row.history_enabled === 1,
        enabledAt: row.enabled_at ? row.enabled_at.getTime() : null,
        disabledAt: row.disabled_at ? row.disabled_at.getTime() : null,
        tzOffsetMinutes: Number(row.tz_offset_minutes) || 0
    };
}

export async function getInsightSettings(userId: string): Promise<InsightSettings> {
    const row = await getUsersDb()
        .prepare(`SELECT * FROM user_insight_settings WHERE user_id = ?`)
        .get<InsightSettingsRow>(userId);
    return rowToSettings(row);
}

export async function isHistoryEnabled(userId: string): Promise<boolean> {
    const row = await getUsersDb()
        .prepare(`SELECT history_enabled FROM user_insight_settings WHERE user_id = ?`)
        .get<{ history_enabled: number }>(userId);
    return row?.history_enabled === 1;
}

export async function setHistoryEnabled(userId: string, enabled: boolean, tzOffsetMinutes?: number): Promise<InsightSettings> {
    // tz_offset_minutes is only overwritten when the caller actually sends one, so toggling history off and
    // on again from a device that didn't report its offset doesn't reset the user's day boundaries
    await getUsersDb().prepare(`
        INSERT INTO user_insight_settings (user_id, history_enabled, enabled_at, disabled_at, tz_offset_minutes)
        VALUES (:userId, :enabled, :enabledAt, :disabledAt, :tz)
        ON DUPLICATE KEY UPDATE
            history_enabled = VALUES(history_enabled),
            enabled_at = IF(VALUES(history_enabled) = 1, VALUES(enabled_at), enabled_at),
            disabled_at = IF(VALUES(history_enabled) = 0, VALUES(disabled_at), disabled_at),
            tz_offset_minutes = IF(:tzGiven = 1, VALUES(tz_offset_minutes), tz_offset_minutes)
    `).run({
        userId,
        enabled: enabled ? 1 : 0,
        enabledAt: enabled ? new Date() : null,
        disabledAt: enabled ? null : new Date(),
        // clamped to the real range of UTC offsets (-12:00 .. +14:00) so a hostile client can't shift its
        // own day boundaries by an arbitrary amount to game "longest streak"
        tz: clampTzOffset(tzOffsetMinutes),
        tzGiven: typeof tzOffsetMinutes === "number" ? 1 : 0
    });

    return await getInsightSettings(userId);
}

export function clampTzOffset(minutes: number | undefined): number {
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) return 0;
    return Math.min(14 * 60, Math.max(-12 * 60, Math.trunc(minutes)));
}

export async function deleteInsightSettings(userId: string): Promise<void> {
    await getUsersDb().prepare(`DELETE FROM user_insight_settings WHERE user_id = ?`).run(userId);
}
