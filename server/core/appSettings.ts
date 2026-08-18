// simple key/value app-wide settings store (users.db)
import { getUsersDb } from "./db";

export function getSetting(key: string): string | null {
    const row = getUsersDb().prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
    getUsersDb().prepare(`
        INSERT INTO app_settings (key, value) VALUES (@key, @value)
        ON CONFLICT(key) DO UPDATE SET value = @value
    `).run({ key, value });
}

// defaults to open (true) so existing installs keep working until an admin explicitly locks registration
export function isRegistrationOpen(): boolean {
    const value = getSetting("register_open");
    return value === null ? true : value === "true";
}

export function setRegistrationOpen(open: boolean): void {
    setSetting("register_open", open ? "true" : "false");
}
