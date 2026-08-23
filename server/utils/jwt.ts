import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";

export interface AuthTokenPayload extends JwtPayload {
    sub: string,
    loginDate: string
}

const ALGORITHM = "HS256";
const ISSUER = "nafyn";

// a short/guessable JWT_SECRET is forgeable, which means anyone can mint a token for any user id -
// including an admin's. Refuse to sign or verify anything against one rather than running insecurely.
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRETS = new Set(["change-me-to-a-long-random-string", "secret", "changeme"]);

function getSecret(): string {
    const secret = useRuntimeConfig().jwtSecret;
    if (!secret) {
        throw createError({ statusCode: 500, statusMessage: "JWT secret is not configured" });
    }
    if (secret.length < MIN_SECRET_LENGTH || PLACEHOLDER_SECRETS.has(secret)) {
        throw createError({ statusCode: 500, statusMessage: "JWT secret is too weak, set JWT_SECRET to a long random string" });
    }
    return secret;
}

// signs a token for `userId`, embedding the login date alongside it
export function signAuthToken(userId: string): string {
    return jwt.sign(
        { sub: userId, loginDate: new Date().toISOString() },
        getSecret(),
        { expiresIn: "7d", algorithm: ALGORITHM, issuer: ISSUER }
    );
}

export function verifyAuthToken(token: string): AuthTokenPayload {
    // SECURITY: `algorithms` must be pinned. Without it the verifier accepts whatever the token's own
    // header asks for, which is the classic JWT algorithm-confusion foothold. `issuer` is pinned for the
    // same reason: a token minted by some other service that happens to share the secret isn't ours.
    const payload = jwt.verify(token, getSecret(), { algorithms: [ALGORITHM], issuer: ISSUER }) as AuthTokenPayload;

    // `jwt.verify` resolves a bare string payload to a string, and `sub` may legally be absent - neither is
    // a token we ever issue, and both would otherwise flow onward as an undefined user id
    if (typeof payload !== "object" || typeof payload.sub !== "string" || !payload.sub) {
        throw new jwt.JsonWebTokenError("Malformed token payload");
    }

    return payload;
}
