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
    ADMIN = 256
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
// ADMIN can edit anyone; MANAGE_ACCOUNTS can edit themselves or anyone without MANAGE_ACCOUNTS/ADMIN
export function canManageUser(actorId: string, actorPerms: number, targetId: string, targetPerms: number): boolean {
    if (actorPerms & Permission.ADMIN) return true;
    if (!(actorPerms & Permission.MANAGE_ACCOUNTS)) return false;
    if (actorId === targetId) return true;
    return !(targetPerms & (Permission.MANAGE_ACCOUNTS | Permission.ADMIN));
}