import jwt from "jsonwebtoken";
import type { JwtPayload } from "jsonwebtoken";
import { isSessionRevoked } from "./sessionCache";

export interface AuthTokenPayload extends JwtPayload {
    sub: string,
    loginDate: string,
    jti: string
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

// signs a token for `userId`. `jti` must be minted by the caller (randomUUID()) *before* calling this, so the
// same value can be persisted as that login's `sessions` row id first - see server/api/v1/auth/login.post.ts.
export function signAuthToken(userId: string, jti: string): string {
    return jwt.sign(
        { sub: userId, loginDate: new Date().toISOString(), jti },
        getSecret(),
        { expiresIn: "7d", algorithm: ALGORITHM, issuer: ISSUER }
    );
}

export async function verifyAuthToken(token: string): Promise<AuthTokenPayload> {
    // SECURITY: `algorithms` must be pinned. Without it the verifier accepts whatever the token's own
    // header asks for, which is the classic JWT algorithm-confusion foothold. `issuer` is pinned for the
    // same reason: a token minted by some other service that happens to share the secret isn't ours.
    const payload = jwt.verify(token, getSecret(), { algorithms: [ALGORITHM], issuer: ISSUER }) as AuthTokenPayload;

    // `jwt.verify` resolves a bare string payload to a string, and `sub`/`jti` may legally be absent - none
    // of this is a token we ever issue, and all would otherwise flow onward as an undefined user id/session
    if (typeof payload !== "object" || typeof payload.sub !== "string" || !payload.sub || typeof payload.jti !== "string" || !payload.jti) {
        throw new jwt.JsonWebTokenError("Malformed token payload");
    }

    if (await isSessionRevoked(payload.jti)) {
        throw new jwt.JsonWebTokenError("Session revoked");
    }

    return payload;
}
