// per-user Nafyn Unity opt-out (Settings -> Sessions).
import { getUsersDb } from "./db";

export interface UnitySettingsRow {
    userId: string,
    enabled: number
}

export interface UnitySettings {
    enabled: boolean
}

export async function getUnitySettings(userId: string): Promise<UnitySettings> {
    const row = await getUsersDb()
        .prepare(`SELECT * FROM user_unity_settings WHERE userId = ?`)
        .get<UnitySettingsRow>(userId);

    if (!row) return { enabled: true };
    return { enabled: row.enabled === 1 };
}

export async function setUnitySettings(userId: string, enabled: boolean): Promise<UnitySettings> {
    await getUsersDb().prepare(`
        INSERT INTO user_unity_settings (userId, enabled)
        VALUES (:userId, :enabled)
        ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)
    `).run({ userId, enabled: enabled ? 1 : 0 });

    return { enabled };
}
