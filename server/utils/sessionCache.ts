// in-memory cache of "is this jti revoked", so server/utils/jwt.ts's verifyAuthToken doesn't hit the DB on
// every single authenticated request (API calls, audio streaming, WS handshakes are all latency-sensitive).
// Same Map + TTL + sweep + hard-cap shape as server/utils/rateLimit.ts. A revoked session can take up to
// CACHE_TTL_MS to be felt by *other* still-connected devices riding it - revokeSessionNow() below bypasses
// that for the device that issued the revoke itself, so it feels instant to the one person who asked for it.
import { isSessionRevokedInDb } from "../core/sessions";

interface CacheEntry {
    revoked: boolean,
    expiresAt: number
}

const cache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 50_000;
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number): void {
    if (now - lastSweep < SWEEP_INTERVAL_MS && cache.size < MAX_ENTRIES) return;
    lastSweep = now;

    for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
    }

    if (cache.size > MAX_ENTRIES) {
        const excess = cache.size - MAX_ENTRIES;
        let dropped = 0;
        for (const key of cache.keys()) {
            cache.delete(key);
            if (++dropped >= excess) break;
        }
    }
}

export async function isSessionRevoked(jti: string): Promise<boolean> {
    const now = Date.now();
    sweep(now);

    const hit = cache.get(jti);
    if (hit && hit.expiresAt > now) return hit.revoked;

    const revoked = await isSessionRevokedInDb(jti);
    cache.set(jti, { revoked, expiresAt: now + CACHE_TTL_MS });
    return revoked;
}

// called right after a session is revoked, so the cache doesn't keep answering "valid" for up to CACHE_TTL_MS
export function markSessionRevoked(jti: string): void {
    cache.set(jti, { revoked: true, expiresAt: Date.now() + CACHE_TTL_MS });
}
