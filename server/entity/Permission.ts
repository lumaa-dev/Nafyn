// ADMIN must always be the highest bit in this enum, so reading the list top to bottom is reading the
// hierarchy bottom to top. A new permission goes in *below* it, which means ADMIN moves up - and because the
// values are stored in users.permissions, moving a bit needs a data migration (server/core/migrations.ts,
// "2026-10-18-admin-highest-permission-bit" is the worked example).
export enum Permission {
    NONE = 0,
    REQUEST_ALBUMS = 1,
    REQUEST_TRACKS = 2,
    MANAGE_REQUESTS = 4,
    AUTOACCEPT_ALBUMS = 8,
    AUTOACCEPT_TRACKS = 16,
    MANAGE_ACCOUNTS = 32,
    MANAGE_MUSIC = 64,
    MANAGE_NOTIFICATIONS = 128,
    MANAGE_WEBHOOKS = 256,
    ADMIN = 512
}

export function hasPermission(permissions: number, requiredPermission: Permission): boolean {
    if (permissions & Permission.ADMIN) return true;
    return !!(permissions & requiredPermission);
}

export function hasPermissions(permissions: number, requiredPermissions: Permission[]): boolean {
    if (permissions & Permission.ADMIN) return true;
    return requiredPermissions.every((p) => permissions & p);
}

// true if `actorPerms` may edit `targetPerms`'s account (profile fields + permission bits):
// nobody edits themselves through the accounts routes - not even an ADMIN. Editing yourself used to be allowed,
// which let a MANAGE_ACCOUNTS user hand themselves any permission that isn't MANAGE_ACCOUNTS/ADMIN
// (MANAGE_MUSIC, the AUTOACCEPT bits, ...), and let an ADMIN strip their own ADMIN bit by accident. Their own
// display name and links live in Settings -> Profile (/user/profile), which needs no such power, and deleting
// their own account has its own password-checked route.
// Past that, ADMIN can edit anyone; MANAGE_ACCOUNTS can only edit accounts strictly below it - never another
// MANAGE_ACCOUNTS holder or an ADMIN.
export function canManageUser(actorId: string, actorPerms: number, targetId: string, targetPerms: number): boolean {
    if (actorId === targetId) return false;
    if (actorPerms & Permission.ADMIN) return true;
    if (!(actorPerms & Permission.MANAGE_ACCOUNTS)) return false;
    return !(targetPerms & (Permission.MANAGE_ACCOUNTS | Permission.ADMIN));
}