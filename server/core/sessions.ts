// one row per login - the server-side counterpart to a signed JWT. The row's id is the same value as the
// JWT's `jti` claim, so a token can be revoked by marking its row revoked (server/utils/jwt.ts checks this,
// through an in-memory cache so it isn't a DB hit on every authenticated request - server/utils/sessionCache.ts).
import { getUsersDb } from "./db";

export interface SessionRow {
    id: string,
    userId: string,
    userAgent: string | null,
    ip: string | null,
    createdAt: number,
    lastSeenAt: number,
    revokedAt: number | null,
    expiresAt: number
}

export async function createSession(userId: string, jti: string, userAgent: string | null, ip: string | null, expiresAt: number): Promise<SessionRow> {
    const row: SessionRow = {
        id: jti,
        userId,
        userAgent,
        ip,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        revokedAt: null,
        expiresAt
    };

    await getUsersDb().prepare(`
        INSERT INTO sessions (id, userId, userAgent, ip, createdAt, lastSeenAt, revokedAt, expiresAt)
        VALUES (:id, :userId, :userAgent, :ip, :createdAt, :lastSeenAt, :revokedAt, :expiresAt)
    `).run(row);

    return row;
}

export async function listSessionsForUser(userId: string): Promise<SessionRow[]> {
    return await getUsersDb().prepare(`
        SELECT * FROM sessions WHERE userId = ? AND revokedAt IS NULL ORDER BY lastSeenAt DESC
    `).all(userId) as SessionRow[];
}

export async function touchSession(jti: string): Promise<void> {
    await getUsersDb().prepare(`UPDATE sessions SET lastSeenAt = ? WHERE id = ?`).run(Date.now(), jti);
}

// revokes only if it belongs to userId, so one user can never revoke another's session by guessing an id.
// soft (revokedAt), not a DELETE, so a caller can tell "never existed" apart from "revoked" if ever needed
export async function revokeSession(userId: string, id: string): Promise<boolean> {
    const result = await getUsersDb().prepare(`
        UPDATE sessions SET revokedAt = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL
    `).run(Date.now(), id, userId);
    return result.changes > 0;
}

export async function isSessionRevokedInDb(jti: string): Promise<boolean> {
    const row = await getUsersDb().prepare(`SELECT revokedAt FROM sessions WHERE id = ?`).get(jti) as { revokedAt: number | null } | undefined;
    return !row || row.revokedAt !== null;
}

// run periodically (server/plugins/unityJobs.ts) - prunes rows whose token could never be valid again even
// if nobody ever revoked it, so the table doesn't grow forever. A short grace past expiresAt costs nothing
// and avoids racing a request that's mid-flight right at the boundary.
export async function sweepExpiredSessions(): Promise<void> {
    await getUsersDb().prepare(`DELETE FROM sessions WHERE expiresAt < ?`).run(Date.now() - 60_000);
}

// every session row ever created for the account, revoked ones included - the data-access export (GDPR
// art. 15) has to disclose the login metadata Nafyn keeps, which includes IP and user agent
export async function listAllSessionsForUser(userId: string): Promise<SessionRow[]> {
    return await getUsersDb().prepare(`
        SELECT * FROM sessions WHERE userId = ? ORDER BY createdAt DESC
    `).all(userId) as SessionRow[];
}

// erasure helper (GDPR art. 17) - a hard DELETE, not the soft revoke above: on account deletion there is no
// longer anything to tell "never existed" apart from, and `ip`/`userAgent` are personal data that must
// actually go. Returns the deleted jtis so the caller can evict them from the in-memory session cache -
// without that, a token issued to the deleted account stays accepted for up to the cache TTL.
export async function deleteAllSessionsForUser(userId: string): Promise<string[]> {
    const db = getUsersDb();
    const rows = await db.prepare(`SELECT id FROM sessions WHERE userId = ?`).all(userId) as { id: string }[];
    await db.prepare(`DELETE FROM sessions WHERE userId = ?`).run(userId);
    return rows.map((row) => row.id);
}

// retention sweep (GDPR art. 5(1)(e)): a revoked row's only remaining job is to make verifyAuthToken() fail
// for its jti, which it does from the moment it is revoked - but it carried an IP and user agent, and
// sweepExpiredSessions() would keep both until the original 7-day expiry. Drop them once no live request
// could still be mid-flight on that token.
export async function sweepRevokedSessions(): Promise<number> {
    const result = await getUsersDb().prepare(`
        DELETE FROM sessions WHERE revokedAt IS NOT NULL AND revokedAt < ?
    `).run(Date.now() - 60_000);
    return result.changes;
}
