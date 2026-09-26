// one fetch helper for every metadata provider: identifies Nafyn with a User-Agent, times out, caches
// successful JSON for a while, and backs a provider off whenever its rate-limit headers say so. A provider
// that's cooling down resolves to null (skipped silently) rather than eating another 429.
import { USER_AGENT } from "../app";

const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

const cache = new Map<string, { value: unknown, expiresAtMs: number }>();
const cooldowns = new Map<string, number>();

export interface ProviderFetchOptions {
    headers?: Record<string, string>,
    // statuses that mean "rate limited" for this provider - iTunes answers 403 instead of 429
    rateLimitStatuses?: number[],
    // lets a provider reject a 200 whose body is really an error (Deezer), so it isn't cached
    acceptBody?: (body: unknown) => boolean
}

export function coolDown(provider: string, ms: number): void {
    const until = Date.now() + ms;
    if ((cooldowns.get(provider) ?? 0) < until) cooldowns.set(provider, until);
}

export function isCoolingDown(provider: string): boolean {
    return (cooldowns.get(provider) ?? 0) > Date.now();
}

// `Retry-After` is either delta-seconds or an HTTP date
function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(seconds, 1) * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(date - Date.now(), 1000);
}

// `X-RateLimit-Reset` is delta-seconds on some APIs and a Unix timestamp on others
function parseReset(value: string | null): number | null {
    if (!value) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n > 1e9 ? Math.max(n * 1000 - Date.now(), 1000) : Math.max(n, 1) * 1000;
}

function readRemaining(headers: Headers): number | null {
    for (const name of ["x-ratelimit-remaining", "x-discogs-ratelimit-remaining", "ratelimit-remaining"]) {
        const value = headers.get(name);
        if (value !== null && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
}

function applyRateLimitHeaders(provider: string, res: Response, limited: boolean): void {
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    const reset = parseReset(res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset"));

    if (limited) {
        coolDown(provider, retryAfter ?? reset ?? DEFAULT_COOLDOWN_MS);
        return;
    }

    // last request of the window went through: stop before the provider has to tell us
    const remaining = readRemaining(res.headers);
    if (remaining !== null && remaining <= 0) {
        coolDown(provider, reset ?? retryAfter ?? DEFAULT_COOLDOWN_MS);
    }
}

export async function providerFetchJson<T>(provider: string, url: string, options: ProviderFetchOptions = {}): Promise<T | null> {
    const cached = cache.get(url);
    if (cached && cached.expiresAtMs > Date.now()) return cached.value as T;
    if (isCoolingDown(provider)) return null;

    let res: Response;
    try {
        res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...options.headers },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        return null;
    }

    const limited = res.status === 429 || (options.rateLimitStatuses?.includes(res.status) ?? false);
    applyRateLimitHeaders(provider, res, limited);
    if (!res.ok) return null;

    let body: unknown;
    try {
        body = await res.json();
    } catch {
        return null;
    }
    if (options.acceptBody && !options.acceptBody(body)) return null;

    if (cache.size >= MAX_CACHE_ENTRIES) {
        // Map keeps insertion order, so the first key is the oldest entry
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(url, { value: body, expiresAtMs: Date.now() + CACHE_TTL_MS });
    return body as T;
}
