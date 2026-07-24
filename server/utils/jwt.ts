import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";

export interface AuthTokenPayload extends JwtPayload {
    sub: string,
    loginDate: string
}

function getSecret(): string {
    const secret = useRuntimeConfig().jwtSecret;
    if (!secret) {
        throw createError({ statusCode: 500, statusMessage: "JWT secret is not configured" });
    }
    return secret;
}

// signs a token for `userId`, embedding the login date alongside it
export function signAuthToken(userId: string): string {
    return jwt.sign({ sub: userId, loginDate: new Date().toISOString() }, getSecret(), { expiresIn: "7d" });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
    return jwt.verify(token, getSecret()) as AuthTokenPayload;
}
