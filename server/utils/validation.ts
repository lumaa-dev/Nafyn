// accounts created before registration was tightened may still hold uppercase letters or "-": login, profiles
// and admin edits keep accepting those
export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,20}$/;

// what a *new* account may be called: lowercase letters, digits, "_" and "."
export const NEW_USERNAME_RE = /^[a-z0-9_.]{3,20}$/;

export function assertValidUsername(username: string): void {
    if (!USERNAME_RE.test(username)) {
        throw createError({ statusCode: 400, statusMessage: "Username must be 3-20 characters (letters, numbers, _ . -)" });
    }
}

export function assertValidNewUsername(username: string): void {
    if (!NEW_USERNAME_RE.test(username)) {
        throw createError({ statusCode: 400, statusMessage: "Username must be 3-20 characters: lowercase letters (a-z), numbers (0-9), _ and ." });
    }
}
