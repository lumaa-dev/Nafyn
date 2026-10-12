// WebAuthn passkeys - an alternative to password login. One row per registered authenticator; a user can
// have several (phone, laptop, security key, ...). `credentialId` is the base64url credential id the
// browser hands back on every authentication, `publicKey` is the COSE public key stored as base64 (there is
// nothing secret in a public key - unlike api_tokens there is no plaintext-password concern here).
import { randomUUID } from "node:crypto";
import { getUsersDb } from "./db";

export interface PasskeyRow {
    id: string,
    userId: string,
    credentialId: string,
    publicKey: string,
    counter: number,
    deviceType: string,
    backedUp: boolean,
    transports: string | null,
    label: string | null,
    createdAt: number,
    lastUsedAt: number | null
}

export type PasskeySummary = Omit<PasskeyRow, "publicKey">;

function stripPublicKey(row: PasskeyRow): PasskeySummary {
    const { publicKey: _publicKey, ...summary } = row;
    return summary;
}

export interface NewPasskey {
    userId: string,
    credentialId: string,
    publicKey: string,
    counter: number,
    deviceType: string,
    backedUp: boolean,
    transports: string | null,
    label: string | null
}

export async function createPasskey(input: NewPasskey): Promise<PasskeyRow> {
    const row: PasskeyRow = {
        id: randomUUID(),
        ...input,
        createdAt: Date.now(),
        lastUsedAt: null
    };

    await getUsersDb().prepare(`
        INSERT INTO passkeys (id, userId, credentialId, publicKey, counter, deviceType, backedUp, transports, label, createdAt, lastUsedAt)
        VALUES (:id, :userId, :credentialId, :publicKey, :counter, :deviceType, :backedUp, :transports, :label, :createdAt, :lastUsedAt)
    `).run({ ...row, backedUp: row.backedUp ? 1 : 0 });

    return row;
}

export async function listPasskeysForUser(userId: string): Promise<PasskeySummary[]> {
    const rows = await getUsersDb().prepare(`
        SELECT * FROM passkeys WHERE userId = ? ORDER BY createdAt DESC
    `).all(userId) as PasskeyRow[];
    return rows.map((row) => stripPublicKey({ ...row, backedUp: !!row.backedUp }));
}

export async function countPasskeysForUser(userId: string): Promise<number> {
    const row = await getUsersDb().prepare(`SELECT COUNT(*) AS n FROM passkeys WHERE userId = ?`).get(userId) as { n: number };
    return row.n;
}

// looked up by credentialId alone (it's globally unique) during login, before we know which user is signing
// in - that's the whole point of a passkey login
export async function getPasskeyByCredentialId(credentialId: string): Promise<PasskeyRow | null> {
    const row = await getUsersDb().prepare(`SELECT * FROM passkeys WHERE credentialId = ?`).get(credentialId) as PasskeyRow | undefined;
    return row ? { ...row, backedUp: !!row.backedUp } : null;
}

// the authenticator's signature counter must only ever move forward - a value that didn't increase is a
// strong signal the credential was cloned, so callers reject the login rather than call this
export async function updatePasskeyCounter(id: string, counter: number): Promise<void> {
    await getUsersDb().prepare(`UPDATE passkeys SET counter = ?, lastUsedAt = ? WHERE id = ?`).run(counter, Date.now(), id);
}

// deletes only if it belongs to userId, so one user can never remove another's passkey by guessing an id
export async function deletePasskey(userId: string, id: string): Promise<boolean> {
    const result = await getUsersDb().prepare(`DELETE FROM passkeys WHERE id = ? AND userId = ?`).run(id, userId);
    return result.changes > 0;
}

export async function listCredentialIdsForUser(userId: string): Promise<string[]> {
    const rows = await getUsersDb().prepare(`SELECT credentialId FROM passkeys WHERE userId = ?`).all(userId) as { credentialId: string }[];
    return rows.map((r) => r.credentialId);
}

// erasure helper (GDPR art. 17): drops every authenticator registered to the account. A passkey's public
// key and credential id are per-account identifiers, so they go with the account.
export async function deleteAllPasskeysForUser(userId: string): Promise<number> {
    const result = await getUsersDb().prepare(`DELETE FROM passkeys WHERE userId = ?`).run(userId);
    return result.changes;
}
