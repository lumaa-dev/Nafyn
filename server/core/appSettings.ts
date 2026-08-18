// simple key/value app-wide settings store (users.db)
import { getUsersDb } from "./db";

export async function getSetting(key: string): Promise<string | null> {
    const row = await getUsersDb().prepare(`SELECT \`value\` FROM app_settings WHERE \`key\` = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
    await getUsersDb().prepare(`
        INSERT INTO app_settings (\`key\`, \`value\`) VALUES (:key, :value)
        ON DUPLICATE KEY UPDATE \`value\` = :value
    `).run({ key, value });
}

// defaults to open (true) so existing installs keep working until an admin explicitly locks registration
export async function isRegistrationOpen(): Promise<boolean> {
    const value = await getSetting("register_open");
    return value === null ? true : value === "true";
}

export async function setRegistrationOpen(open: boolean): Promise<void> {
    await setSetting("register_open", open ? "true" : "false");
}
