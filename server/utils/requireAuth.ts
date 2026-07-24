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
