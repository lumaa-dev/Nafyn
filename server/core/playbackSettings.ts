// per-user playback preferences (Settings -> Playback): crossfade on/off and its length.
import { getUsersDb } from "./db";

export const CROSSFADE_MIN_MS = 500;
export const CROSSFADE_MAX_MS = 12000;
export const CROSSFADE_DEFAULT_MS = 3000;

export interface PlaybackSettingsRow {
    userId: string,
    crossfadeEnabled: number,
    crossfadeMs: number
}

export interface PlaybackSettings {
    crossfadeEnabled: boolean,
    crossfadeMs: number
}

export function clampCrossfadeMs(ms: number): number {
    return Math.round(Math.min(CROSSFADE_MAX_MS, Math.max(CROSSFADE_MIN_MS, ms)));
}

export async function getPlaybackSettings(userId: string): Promise<PlaybackSettings> {
    const row = await getUsersDb()
        .prepare(`SELECT * FROM user_playback_settings WHERE userId = ?`)
        .get<PlaybackSettingsRow>(userId);

    if (!row) return { crossfadeEnabled: true, crossfadeMs: CROSSFADE_DEFAULT_MS };
    return { crossfadeEnabled: row.crossfadeEnabled === 1, crossfadeMs: clampCrossfadeMs(row.crossfadeMs) };
}

export async function setPlaybackSettings(
    userId: string,
    changes: { crossfadeEnabled?: boolean, crossfadeMs?: number }
): Promise<PlaybackSettings> {
    const current = await getPlaybackSettings(userId);

    const crossfadeEnabled = changes.crossfadeEnabled ?? current.crossfadeEnabled;
    const crossfadeMs = changes.crossfadeMs === undefined ? current.crossfadeMs : clampCrossfadeMs(changes.crossfadeMs);

    await getUsersDb().prepare(`
        INSERT INTO user_playback_settings (userId, crossfadeEnabled, crossfadeMs)
        VALUES (:userId, :crossfadeEnabled, :crossfadeMs)
        ON DUPLICATE KEY UPDATE
            crossfadeEnabled = VALUES(crossfadeEnabled),
            crossfadeMs = VALUES(crossfadeMs)
    `).run({
        userId,
        crossfadeEnabled: crossfadeEnabled ? 1 : 0,
        crossfadeMs
    });

    return { crossfadeEnabled, crossfadeMs };
}
