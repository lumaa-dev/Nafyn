// `DiscyUser`s stuff
import { randomUUID, UUID } from "node:crypto";
import { getUsersDb } from "./db";
import type { DiscyUser } from "../entity/DiscyUser";
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

function rowToUser(row: UserRow): DiscyUser {
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

// creates a `DiscyUser`, id is generated as a UUID if not given
export function createUser(user: Omit<DiscyUser, "id"> & { id?: UUID }, passwordHash: string): DiscyUser {
    const id = (user.id ?? randomUUID()) as string;

    let permcount = typeof user.permissions == "number" ? user.permissions : 0;
    if (Array.isArray(user.permissions) && user.permissions.length > 1 && !user.permissions.includes(Permission.NONE)) {
        user.permissions.forEach((p) => permcount += p);
    }

    user.permissions = permcount;

    getUsersDb().prepare(`
        INSERT INTO users (id, username, passwordHash, displayName, avatar, permissions, lastFm, discogs)
        VALUES (@id, @username, @passwordHash, @displayName, @avatar, @permissions, @lastFm, @discogs)
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


    return { ...user, id } as DiscyUser;
}

export function getUserById(id: UUID | string, compact: boolean = false): DiscyUser | null {
    let v: string = compact ? `id, username, displayName, avatar` : `*`
    const row = getUsersDb().prepare(`SELECT ${v} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
}

export function getUserByUsername(username: string): DiscyUser | null {
    const row = getUsersDb().prepare(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
    return row ? rowToUser(row) : null;
}

// gets stored password hash for a username, used by login to verify a password against it
export function getPasswordHash(username: string): string | null {
    const row = getUsersDb().prepare(`SELECT passwordHash FROM users WHERE username = ?`).get(username) as { passwordHash: string } | undefined;
    return row?.passwordHash ?? null;
}

// gets stored password hash for a username, used by login to verify a password against it
export function getPermissionsById(id: UUID | string): number | null {
    const row = getUsersDb().prepare(`SELECT permissions FROM users WHERE id = ?`).get(id) as { permissions: number } | undefined;
    return row?.permissions ?? null;
}

export function isUsernameTaken(username: string): boolean {
    const row = getUsersDb().prepare(`SELECT 1 FROM users WHERE username = ?`).get(username);
    return !!row;
}

// partially updates a user; only defined fields are changed
export function updateUser(id: string, changes: Partial<Omit<DiscyUser, "id">>): DiscyUser | null {
    const existing = getUserById(id);
    if (!existing) return null;

    const merged = { ...existing, ...changes };
    getUsersDb().prepare(`
        UPDATE users
        SET displayName = @displayName, avatar = @avatar, permissions = @permissions, lastFm = @lastFm, discogs = @discogs
        WHERE id = @id
    `).run({
        id,
        displayName: merged.displayName ?? null,
        avatar: merged.avatar ?? null,
        permissions: merged.permissions as unknown as number,
        lastFm: merged.lastFm ?? null,
        discogs: merged.discogs ?? null
    });

    return merged;
}

export function updatePasswordHash(id: string, passwordHash: string): void {
    getUsersDb().prepare(`UPDATE users SET passwordHash = ? WHERE id = ?`).run(passwordHash, id);
}

export function deleteUser(id: string): boolean {
    const result = getUsersDb().prepare(`DELETE FROM users WHERE id = ?`).run(id);
    return result.changes > 0;
}

export function listUsers(): DiscyUser[] {
    const rows = getUsersDb().prepare(`SELECT * FROM users`).all() as UserRow[];
    return rows.map(rowToUser);
}
