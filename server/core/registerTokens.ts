// one-time, 4-hour-lived tokens that unlock /register when open registration is disabled
import { randomBytes, randomUUID } from "node:crypto";
import { getUsersDb } from "./db";

const TOKEN_LIFETIME_MS = 4 * 60 * 60 * 1000;

export interface RegisterTokenRow {
    id: string,
    token: string,
    createdBy: string,
    createdAt: number,
    expiresAt: number,
    usedAt: number | null
}

export async function createRegisterToken(createdBy: string): Promise<RegisterTokenRow> {
    const now = Date.now();
    const row: RegisterTokenRow = {
        id: randomUUID(),
        token: randomBytes(24).toString("hex"),
        createdBy,
        createdAt: now,
        expiresAt: now + TOKEN_LIFETIME_MS,
        usedAt: null
    };

    await getUsersDb().prepare(`
        INSERT INTO register_tokens (id, token, createdBy, createdAt, expiresAt, usedAt)
        VALUES (:id, :token, :createdBy, :createdAt, :expiresAt, :usedAt)
    `).run(row);

    return row;
}

// unused and unexpired only
export async function validateRegisterToken(token: string): Promise<RegisterTokenRow | null> {
    const row = await getUsersDb().prepare(`
        SELECT * FROM register_tokens WHERE token = ? AND usedAt IS NULL AND expiresAt > ?
    `).get(token, Date.now()) as RegisterTokenRow | undefined;
    return row ?? null;
}

// SECURITY: claims the token atomically - the `usedAt IS NULL` guard lives in the UPDATE itself, so of any
// number of registrations racing on one token exactly one sees `changes === 1`. Checking with
// validateRegisterToken() and marking it used afterwards let several parallel requests all pass the check
// before any of them wrote `usedAt`, turning a one-time invite into as many accounts as could be fired at once.
export async function claimRegisterToken(id: string): Promise<boolean> {
    const result = await getUsersDb()
        .prepare(`UPDATE register_tokens SET usedAt = ? WHERE id = ? AND usedAt IS NULL AND expiresAt > ?`)
        .run(Date.now(), id, Date.now());
    return result.changes === 1;
}

// hands a claimed token back, used when the registration it was claimed for fails afterwards
export async function releaseRegisterToken(id: string): Promise<void> {
    await getUsersDb().prepare(`UPDATE register_tokens SET usedAt = NULL WHERE id = ?`).run(id);
}

export async function listActiveRegisterTokens(): Promise<RegisterTokenRow[]> {
    return await getUsersDb().prepare(`
        SELECT * FROM register_tokens WHERE usedAt IS NULL AND expiresAt > ? ORDER BY createdAt DESC
    `).all(Date.now()) as RegisterTokenRow[];
}
