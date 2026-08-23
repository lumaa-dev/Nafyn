import { promises as dns } from "node:dns";
import { normalizeIp } from "./clientIp";

interface Bucket {
    count: number,
    expiresAt: number
}

const buckets = new Map<string, Bucket>();

// SECURITY: the bucket map is keyed partly by attacker-controlled input (the attempted username), so
// without a ceiling a flood of unique usernames grows it without bound until the process runs out of
// memory. Expired buckets are swept opportunistically, and the map is hard-capped as a backstop.
const MAX_BUCKETS = 50_000;
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number): void {
    if (now - lastSweep < SWEEP_INTERVAL_MS && buckets.size < MAX_BUCKETS) return;
    lastSweep = now;

    for (const [key, bucket] of buckets) {
        if (bucket.expiresAt <= now) buckets.delete(key);
    }

    // still over the cap after dropping everything expired: evict oldest-inserted entries (Map preserves
    // insertion order) until back under it. Dropping a live bucket only ever resets someone's counter, it
    // can never grant access, so failing this way is safe.
    if (buckets.size > MAX_BUCKETS) {
        const excess = buckets.size - MAX_BUCKETS;
        let dropped = 0;
        for (const key of buckets.keys()) {
            buckets.delete(key);
            if (++dropped >= excess) break;
        }
    }
}

export interface RateLimitResult {
    allowed: boolean,
    retryAfterSeconds: number
}

export function consumeRateLimit(key: string, max: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    sweep(now);

    const bucket = buckets.get(key);

    if (!bucket || bucket.expiresAt <= now) {
        buckets.set(key, { count: 1, expiresAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
    }

    if (bucket.count >= max) {
        return { allowed: false, retryAfterSeconds: Math.ceil((bucket.expiresAt - now) / 1000) };
    }

    bucket.count++;
    return { allowed: true, retryAfterSeconds: 0 };
}

// clears a key's attempts, used after a successful login so honest typos don't linger
export function resetRateLimit(key: string): void {
    buckets.delete(key);
}

// resolved whitelist domains -> IPs, so a DNS lookup doesn't run on every single request (and so a DNS
// outage can't stall the login path). Short TTL because whitelisted hosts are usually dynamic-DNS names.
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
let whitelistCache: { ips: Set<string>, expiresAtMs: number } | null = null;

async function resolveWhitelist(domains: string[]): Promise<Set<string>> {
    const now = Date.now();
    if (whitelistCache && whitelistCache.expiresAtMs > now) return whitelistCache.ips;

    const ips = new Set<string>();
    // a domain that fails to resolve simply contributes no IPs - it must never widen the whitelist
    const settled = await Promise.allSettled(domains.map(async (domain) => {
        const [v4, v6] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
        const found: string[] = [];
        if (v4.status === "fulfilled") found.push(...v4.value);
        if (v6.status === "fulfilled") found.push(...v6.value);
        return found;
    }));

    for (const result of settled) {
        if (result.status === "fulfilled") {
            for (const ip of result.value) ips.add(normalizeIp(ip));
        }
    }

    whitelistCache = { ips, expiresAtMs: now + DNS_CACHE_TTL_MS };
    return ips;
}

// SECURITY: this used to be `domains.some(async (d) => ...)`. `Array.some` tests the *return value* of its
// callback for truthiness, and an async function always returns a (truthy) Promise - so it returned `true`
// for every IP the moment DOMAINS_WHITELIST held anything at all, silently disabling rate limiting for the
// entire internet. Every caller must also `await` this; `if (!isWhitelisted(ip))` on the raw Promise is
// likewise always false and disables the limiter just as completely.
export async function isWhitelisted(ip: string | null): Promise<boolean> {
    if (!ip || ip === "unknown") return false;

    const raw = useRuntimeConfig().domainsWhitelist;
    if (!raw) return false;

    const domains = raw.split(/[,\s]+/g).map((d: string) => d.trim()).filter(Boolean);
    if (domains.length === 0) return false;

    const ips = await resolveWhitelist(domains);
    return ips.has(normalizeIp(ip));
}
