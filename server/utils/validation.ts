export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,20}$/;

export function assertValidUsername(username: string): void {
    if (!USERNAME_RE.test(username)) {
        throw createError({ statusCode: 400, statusMessage: "Username must be 3-20 characters (letters, numbers, _ . -)" });
    }
}
