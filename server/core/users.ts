// `NafynUser`s stuff
import { randomUUID, UUID } from "node:crypto";
import { getUsersDb } from "./db";
import type { NafynUser } from "../entity/NafynUser";
import { Permission } from "../entity/Permission";

interface UserRow {
    id: string,
    username: string,
    passwordHash: string,
    displayName: string | null,
    avatar: string | null,
    permissions: number,
    lastFm: string | null,
    discogs: string | null
}

function rowToUser(row: UserRow): NafynUser {
    return {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        avatar: row.avatar,
        permissions: row.permissions as unknown as Permission[],
        lastFm: row.lastFm,
        discogs: row.discogs
    };
}

// creates a `NafynUser`, id is generated as a UUID if not given
export async function createUser(user: Omit<NafynUser, "id"> & { id?: UUID }, passwordHash: string): Promise<NafynUser> {
    const id = (user.id ?? randomUUID()) as string;

    let permcount = typeof user.permissions == "number" ? user.permissions : 0;
    if (Array.isArray(user.permissions) && user.permissions.length > 1 && !user.permissions.includes(Permission.NONE)) {
        user.permissions.forEach((p) => permcount += p);
    }

    user.permissions = permcount;

    await getUsersDb().prepare(`
        INSERT INTO users (id, username, passwordHash, displayName, avatar, permissions, lastFm, discogs)
        VALUES (:id, :username, :passwordHash, :displayName, :avatar, :permissions, :lastFm, :discogs)
    `).run({
        id,
        username: user.username,
        passwordHash,
        displayName: user.displayName ?? null,
        avatar: user.avatar ?? null,
        permissions: user.permissions,
        lastFm: user.lastFm ?? null,
        discogs: user.discogs ?? null
    });


    return { ...user, id } as NafynUser;
}

export async function getUserById(id: UUID | string, compact: boolean = false): Promise<NafynUser | null> {
    let v: string = compact ? `id, username, displayName, avatar` : `*`
    const row = await getUsersDb().prepare(`SELECT ${v} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
}

export async function getUserByUsername(username: string): Promise<NafynUser | null> {
    const row = await getUsersDb().prepare(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
    return row ? rowToUser(row) : null;
}

// gets stored password hash for a username, used by login to verify a password against it
export async function getPasswordHash(username: string): Promise<string | null> {
    const row = await getUsersDb().prepare(`SELECT passwordHash FROM users WHERE username = ?`).get(username) as { passwordHash: string } | undefined;
    return row?.passwordHash ?? null;
}

// gets stored password hash for a username, used by login to verify a password against it
export async function getPermissionsById(id: UUID | string): Promise<number | null> {
    const row = await getUsersDb().prepare(`SELECT permissions FROM users WHERE id = ?`).get(id) as { permissions: number } | undefined;
    return row?.permissions ?? null;
}

export async function isUsernameTaken(username: string): Promise<boolean> {
    const row = await getUsersDb().prepare(`SELECT 1 FROM users WHERE username = ?`).get(username);
    return !!row;
}

// partially updates a user; only defined fields are changed
export async function updateUser(id: string, changes: Partial<Omit<NafynUser, "id">>): Promise<NafynUser | null> {
    const existing = await getUserById(id);
    if (!existing) return null;

    const merged = { ...existing, ...changes };
    await getUsersDb().prepare(`
        UPDATE users
        SET username = :username, displayName = :displayName, avatar = :avatar, permissions = :permissions, lastFm = :lastFm, discogs = :discogs
        WHERE id = :id
    `).run({
        id,
        username: merged.username,
        displayName: merged.displayName ?? null,
        avatar: merged.avatar ?? null,
        permissions: merged.permissions as unknown as number,
        lastFm: merged.lastFm ?? null,
        discogs: merged.discogs ?? null
    });

    return merged;
}

export async function updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await getUsersDb().prepare(`UPDATE users SET passwordHash = ? WHERE id = ?`).run(passwordHash, id);
}

export async function deleteUser(id: string): Promise<boolean> {
    const result = await getUsersDb().prepare(`DELETE FROM users WHERE id = ?`).run(id);
    return result.changes > 0;
}

export async function listUsers(limit?: number, offset?: number): Promise<NafynUser[]> {
    let sql = `SELECT * FROM users ORDER BY username ASC`;
    const params: unknown[] = [];
    if (limit !== undefined) {
        sql += ` LIMIT ? OFFSET ?`;
        params.push(limit, offset ?? 0);
    }
    const rows = await getUsersDb().prepare(sql).all(...params) as UserRow[];
    return rows.map(rowToUser);
}

export async function countUsers(): Promise<number> {
    const row = await getUsersDb().prepare(`SELECT COUNT(*) AS count FROM users`).get() as { count: number };
    return Number(row.count);
}
