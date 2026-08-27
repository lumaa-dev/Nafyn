import type { H3Event } from "h3";
import { verifyAuthToken } from "./jwt";
import type { AuthTokenPayload } from "./jwt";

// extracts + verifies the `Authorization: Bearer <token>` header, throws 401 if missing/invalid/expired
export function requireAuthToken(event: H3Event): AuthTokenPayload {
    const auth = getHeader(event, "Authorization");
    if (!auth?.startsWith("Bearer ")) {
        throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
    }

    const token = auth.slice("Bearer ".length).trim();

    try {
        return verifyAuthToken(token);
    } catch {
        throw createError({ statusCode: 401, statusMessage: "Invalid or expired token" });
    }
}

// same as requireAuthToken, but also accepts `?token=` for the handful of callers that physically cannot set
// an Authorization header: <audio>/<video> element sources, the WebSocket handshake, and navigator.sendBeacon
// (which supports no custom headers at all). Prefer requireAuthToken everywhere else - a token in a query
// string leaks into access logs and Referer headers, so this is a concession, not a convenience.
export function requireAuthTokenAllowQuery(event: H3Event): AuthTokenPayload {
    const header = getHeader(event, "Authorization");
    const query = getQuery(event);
    const raw = header ?? (typeof query.token === "string" ? query.token : null);

    if (!raw) {
        throw createError({ statusCode: 401, statusMessage: "Not authenticated" });
    }

    const token = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : raw;

    try {
        return verifyAuthToken(token);
    } catch {
        throw createError({ statusCode: 401, statusMessage: "Invalid or expired token" });
    }
}
