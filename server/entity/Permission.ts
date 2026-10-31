// ADMIN must always be the highest bit in this enum, so reading the list top to bottom is reading the
// hierarchy bottom to top. A new permission goes in *below* it, which means ADMIN moves up - and because the
// values are stored in users.permissions, moving a bit needs a data migration (server/core/migrations.ts)
// that remaps the existing rows.
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
// - nobody edits themselves through the accounts routes - not even an ADMIN. Their own display name and links
//   live in Settings -> Profile (/user/profile), and deleting their own account has its own password-checked route.
// - ADMIN edits anyone except another ADMIN (a MANAGE_ACCOUNTS holder included).
// - MANAGE_ACCOUNTS edits only accounts holding neither MANAGE_ACCOUNTS nor ADMIN.
// - anyone else edits nobody.
// Granting or revoking MANAGE_ACCOUNTS / ADMIN stays ADMIN-only (users/[id].patch.ts).
export const ACCOUNT_MANAGER_BITS = Permission.MANAGE_ACCOUNTS | Permission.ADMIN;

export function canManageUser(actorId: string, actorPerms: number, targetId: string, targetPerms: number): boolean {
    if (actorId === targetId) return false;
    if (actorPerms & Permission.ADMIN) return !(targetPerms & Permission.ADMIN);
    if (actorPerms & Permission.MANAGE_ACCOUNTS) return !(targetPerms & ACCOUNT_MANAGER_BITS);
    return false;
}
