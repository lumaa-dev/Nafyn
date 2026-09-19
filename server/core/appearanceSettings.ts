// per-user display preferences (Settings -> Appearance): whether track lists show file size / duration.
//
// showFileSize is additionally gated by the MANAGE_MUSIC permission - a user without it can never see it
// regardless of what's stored, so both read and write paths take the caller's permissions and enforce that
// server-side rather than trusting the client to hide the toggle.
import { getUsersDb } from "./db";
import { hasPermission, Permission } from "../entity/Permission";

export interface AppearanceSettingsRow {
    userId: string,
    showFileSize: number,
    showDuration: number
}

export interface AppearanceSettings {
    showFileSize: boolean,
    showDuration: boolean
}

function rowToSettings(row: AppearanceSettingsRow | undefined): AppearanceSettings {
    // no row means the defaults apply: both visible
    if (!row) return { showFileSize: true, showDuration: true };
    return { showFileSize: row.showFileSize === 1, showDuration: row.showDuration === 1 };
}

function canSeeFileSize(permissions: number): boolean {
    return hasPermission(permissions, Permission.MANAGE_MUSIC) || hasPermission(permissions, Permission.ADMIN);
}

export async function getAppearanceSettings(userId: string, permissions: number): Promise<AppearanceSettings> {
    const row = await getUsersDb()
        .prepare(`SELECT * FROM user_appearance_settings WHERE userId = ?`)
        .get<AppearanceSettingsRow>(userId);
    const settings = rowToSettings(row);

    // locked off regardless of what's stored - a permission that's since been revoked must not leave the
    // toggle looking "on" for a user who can no longer see file sizes anywhere else in the app
    if (!canSeeFileSize(permissions)) settings.showFileSize = false;

    return settings;
}

export async function setAppearanceSettings(
    userId: string,
    permissions: number,
    changes: { showFileSize?: boolean, showDuration?: boolean }
): Promise<AppearanceSettings> {
    const current = await getAppearanceSettings(userId, permissions);

    const showFileSize = changes.showFileSize === undefined
        ? current.showFileSize
        : (changes.showFileSize && canSeeFileSize(permissions));
    const showDuration = changes.showDuration ?? current.showDuration;

    await getUsersDb().prepare(`
        INSERT INTO user_appearance_settings (userId, showFileSize, showDuration)
        VALUES (:userId, :showFileSize, :showDuration)
        ON DUPLICATE KEY UPDATE
            showFileSize = VALUES(showFileSize),
            showDuration = VALUES(showDuration)
    `).run({
        userId,
        showFileSize: showFileSize ? 1 : 0,
        showDuration: showDuration ? 1 : 0
    });

    return { showFileSize, showDuration };
}
