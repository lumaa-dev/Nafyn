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
    return permissions == Permission.ADMIN || (permissions > 0 && !!(permissions % requiredPermission));
}

export function hasPermissions(permissions: number, requiredPermissions: Permission[]): boolean {
    if (permissions > 0 && permissions != Permission.ADMIN) {
        return requiredPermissions.every((p) => permissions & p);
    }
    return permissions == Permission.ADMIN;
}