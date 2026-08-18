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

export function createRegisterToken(createdBy: string): RegisterTokenRow {
    const now = Date.now();
    const row: RegisterTokenRow = {
        id: randomUUID(),
        token: randomBytes(24).toString("hex"),
        createdBy,
        createdAt: now,
        expiresAt: now + TOKEN_LIFETIME_MS,
        usedAt: null
    };

    getUsersDb().prepare(`
        INSERT INTO register_tokens (id, token, createdBy, createdAt, expiresAt, usedAt)
        VALUES (@id, @token, @createdBy, @createdAt, @expiresAt, @usedAt)
    `).run(row);

    return row;
}

// unused and unexpired only
export function validateRegisterToken(token: string): RegisterTokenRow | null {
    const row = getUsersDb().prepare(`
        SELECT * FROM register_tokens WHERE token = ? AND usedAt IS NULL AND expiresAt > ?
    `).get(token, Date.now()) as RegisterTokenRow | undefined;
    return row ?? null;
}

export function consumeRegisterToken(id: string): void {
    getUsersDb().prepare(`UPDATE register_tokens SET usedAt = ? WHERE id = ?`).run(Date.now(), id);
}

export function listActiveRegisterTokens(): RegisterTokenRow[] {
    return getUsersDb().prepare(`
        SELECT * FROM register_tokens WHERE usedAt IS NULL AND expiresAt > ? ORDER BY createdAt DESC
    `).all(Date.now()) as RegisterTokenRow[];
}
