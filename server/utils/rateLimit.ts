interface Bucket {
    count: number,
    expiresAt: number
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
    allowed: boolean,
    retryAfterSeconds: number
}

export function consumeRateLimit(key: string, max: number, windowMs: number): RateLimitResult {
    const now = Date.now();
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
