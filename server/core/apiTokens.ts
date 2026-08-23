// user-generated, revocable "API tokens" - app-password style secrets a user can hand to a third-party
// client (currently: Subsonic-compatible apps) instead of their real account password. Stored as plaintext,
// unlike the bcrypt-hashed account password, specifically so the server can support Subsonic's token-auth
// challenge (t = md5(secret + s)), which needs a secret it can re-hash and compare - impossible against a
// one-way hash. Scope is intentionally narrow (Subsonic today) but the table/shape is generic.
import { randomBytes, randomUUID } from "node:crypto";
import { getUsersDb } from "./db";

export interface ApiTokenRow {
    id: string,
    userId: string,
    name: string | null,
    token: string,
    createdAt: number,
    lastUsedAt: number | null
}

// omits `token` - the value is only ever returned once, at creation time (see createApiToken)
export type ApiTokenSummary = Omit<ApiTokenRow, "token">;

function stripToken(row: ApiTokenRow): ApiTokenSummary {
    const { token: _token, ...summary } = row;
    return summary;
}

export async function createApiToken(userId: string, name: string | null): Promise<ApiTokenRow> {
    const row: ApiTokenRow = {
        id: randomUUID(),
        userId,
        name,
        token: randomBytes(24).toString("hex"),
        createdAt: Date.now(),
        lastUsedAt: null
    };

    await getUsersDb().prepare(`
        INSERT INTO api_tokens (id, userId, name, token, createdAt, lastUsedAt)
        VALUES (:id, :userId, :name, :token, :createdAt, :lastUsedAt)
    `).run(row);

    return row;
}

export async function listApiTokensForUser(userId: string): Promise<ApiTokenSummary[]> {
    const rows = await getUsersDb().prepare(`
        SELECT * FROM api_tokens WHERE userId = ? ORDER BY createdAt DESC
    `).all(userId) as ApiTokenRow[];
    return rows.map(stripToken);
}

// every token for a user, plaintext included - only for Subsonic's auth challenge (server/utils/subsonicAuth.ts),
// which has to hash each candidate secret itself; never exposed over HTTP
export async function listApiTokenSecretsForUser(userId: string): Promise<ApiTokenRow[]> {
    return await getUsersDb().prepare(`
        SELECT * FROM api_tokens WHERE userId = ?
    `).all(userId) as ApiTokenRow[];
}

// looks up the owning user by the token's plaintext value, for clients that pass the token straight as p=
export async function findApiTokenBySecret(token: string): Promise<ApiTokenRow | null> {
    const row = await getUsersDb().prepare(`SELECT * FROM api_tokens WHERE token = ?`).get(token) as ApiTokenRow | undefined;
    return row ?? null;
}

export async function touchApiToken(id: string): Promise<void> {
    await getUsersDb().prepare(`UPDATE api_tokens SET lastUsedAt = ? WHERE id = ?`).run(Date.now(), id);
}

// deletes only if it belongs to userId, so one user can never revoke another's token by guessing an id
export async function deleteApiToken(userId: string, id: string): Promise<boolean> {
    const result = await getUsersDb().prepare(`DELETE FROM api_tokens WHERE id = ? AND userId = ?`).run(id, userId);
    return result.changes > 0;
}
