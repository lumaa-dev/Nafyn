// The only place in Nafyn that talks to the MusicBrainz web service.
//
//  - one process-wide rate limiter (MusicBrainz asks anonymous clients for ~1 request/second)
//  - a descriptive User-Agent with contact info
//  - retry with exponential backoff on 429/5xx/network errors, honouring Retry-After
//  - a circuit breaker, so an outage fails fast instead of queueing every caller behind timeouts
//  - request de-duplication (identical in-flight requests share one HTTP call) and a TTL cache
//
// `musicbrainz-api` is used for its TypeScript types only. Its own client resolves an error response
// (404, 503 "server busy") to the JSON body instead of throwing, applies a 15-per-18-seconds limiter of
// its own and a 500 ms timeout, none of which is what a shared, long-running server wants.
//
// Errors are always thrown, as `MusicBrainzError` with the HTTP status: 400 invalid id, 404 unknown id,
// 503 busy/unavailable (also what an open circuit breaker or a saturated queue reports).

import type { MusicBrainzApi } from "musicbrainz-api";

export type QueryParams = Record<string, string | number | undefined>;

export interface TransportResponse {
    status: number,
    /** Seconds from a `Retry-After` header, when present. */
    retryAfter?: number,
    body: unknown
}

/** One GET against the web service. Swappable so tests and fixture recording never touch the network. */
export type Transport = (url: string, init: { userAgent: string, timeoutMs: number }) => Promise<TransportResponse>;

export class MusicBrainzError extends Error {
    constructor(message: string, readonly status: number, readonly retryable = false) {
        super(message);
        this.name = "MusicBrainzError";
    }
}

export interface RepositoryOptions {
    baseUrl: string,
    userAgent: string,
    transport: Transport,
    /** Minimum spacing between two requests, across every caller. */
    minIntervalMs: number,
    /** A request that would have to wait longer than this for its turn is refused. */
    maxQueueWaitMs: number,
    timeoutMs: number,
    maxRetries: number,
    retryBaseMs: number,
    breakerThreshold: number,
    breakerCooldownMs: number,
    searchTtlMs: number,
    lookupTtlMs: number,
    notFoundTtlMs: number,
    maxCacheEntries: number,
    now: () => number,
    sleep: (ms: number) => Promise<void>
}

export const defaultTransport: Transport = async (url, { userAgent, timeoutMs }) => {
    const response = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
    });
    const retryAfter = Number(response.headers.get("retry-after"));
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined, body };
};

export const DEFAULT_REPOSITORY_OPTIONS: Omit<RepositoryOptions, "userAgent"> = {
    baseUrl: "https://musicbrainz.org/ws/2",
    transport: defaultTransport,
    minIntervalMs: 1100,
    maxQueueWaitMs: 30_000,
    timeoutMs: 15_000,
    maxRetries: 3,
    retryBaseMs: 1000,
    breakerThreshold: 5,
    breakerCooldownMs: 30_000,
    searchTtlMs: 10 * 60_000,
    lookupTtlMs: 15 * 60_000,
    notFoundTtlMs: 5 * 60_000,
    maxCacheEntries: 800,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

interface CacheEntry {
    expires: number,
    value?: unknown,
    notFound?: boolean
}

// special characters of the Lucene query syntax MusicBrainz search uses
const LUCENE_SPECIAL = /[+\-!(){}[\]^"~*?:\\/&|]/g;

/** Escapes every Lucene operator, for a bare (unquoted) term. */
export function escapeLucene(term: string): string {
    return term.replace(LUCENE_SPECIAL, "\\$&");
}

/** A quoted phrase: inside quotes only the quote and the backslash are special. */
export function luceneQuote(phrase: string): string {
    return `"${phrase.replace(/[\\"]/g, "\\$&")}"`;
}

/** Bare terms, all required: `a b` -> `a AND b`, each escaped. */
export function luceneTerms(text: string): string {
    return text.split(/\s+/).filter(Boolean).map(escapeLucene).join(" AND ");
}

/**
 * Bare terms, all required, the longer ones fuzzy (`hatashi~` also finds "hatachi"): for a query that may carry
 * a typo. Short words stay exact, a fuzzy "no" would match half the index.
 */
export function luceneFuzzyTerms(text: string, minFuzzyLength = 5): string {
    return text.split(/\s+/).filter(Boolean)
        .map((term) => (Array.from(term).length >= minFuzzyLength && /^[\p{Script=Latin}\p{N}']+$/u.test(term) ? `${escapeLucene(term)}~` : escapeLucene(term)))
        .join(" AND ");
}

export class MusicBrainzRepository {
    private readonly options: RepositoryOptions;
    private readonly cache = new Map<string, CacheEntry>();
    private readonly inFlight = new Map<string, Promise<unknown>>();

    // rate limiter: the next instant a request may leave
    private nextSlot = 0;

    // circuit breaker
    private consecutiveFailures = 0;
    private openUntil = 0;
    private probing = false;

    constructor(options: Partial<RepositoryOptions> & Pick<RepositoryOptions, "userAgent">) {
        this.options = { ...DEFAULT_REPOSITORY_OPTIONS, ...options };
    }

    // ------------------------------------------------------------ public API (musicbrainz-api compatible)

    lookup: MusicBrainzApi["lookup"] = ((entity: string, mbid: string, inc: string[] = []) =>
        this.get(`/${entity}/${encodeURIComponent(mbid)}`, { inc: inc.join(" ") || undefined }, this.options.lookupTtlMs)) as MusicBrainzApi["lookup"];

    browse: MusicBrainzApi["browse"] = ((entity: string, query: Record<string, unknown> = {}, inc?: string[]) => {
        const params: QueryParams = {};
        for (const [key, value] of Object.entries(query)) {
            if (value === undefined) continue;
            params[key] = Array.isArray(value) ? value.join("|") : (value as string | number);
        }
        if (inc?.length) params.inc = inc.join(" ");
        return this.get(`/${entity}`, params, this.options.lookupTtlMs);
    }) as MusicBrainzApi["browse"];

    search: MusicBrainzApi["search"] = ((entity: string, query: { query?: string, limit?: number, offset?: number, inc?: string[] }) =>
        this.get(`/${entity}`, {
            query: typeof query.query === "string" ? query.query : undefined,
            limit: query.limit,
            offset: query.offset,
            inc: query.inc?.join(" ")
        }, this.options.searchTtlMs)) as MusicBrainzApi["search"];

    /** Typed escape hatch for the search engine, which reads only the fields it needs. */
    request<T>(path: string, params: QueryParams = {}, ttlMs = this.options.searchTtlMs): Promise<T> {
        return this.get(path, params, ttlMs) as Promise<T>;
    }

    // ------------------------------------------------------------ internals

    private buildUrl(path: string, params: QueryParams): string {
        const pairs: string[] = [];
        for (const [key, value] of Object.entries({ ...params, fmt: "json" }).sort(([a], [b]) => a.localeCompare(b))) {
            if (value === undefined || value === "") continue;
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
        }
        const query = pairs.join("&");
        return `${this.options.baseUrl}${path}${query ? `?${query}` : ""}`;
    }

    private async get(path: string, params: QueryParams, ttlMs: number): Promise<unknown> {
        const url = this.buildUrl(path, params);
        const now = this.options.now();

        const cached = this.cache.get(url);
        if (cached && cached.expires > now) {
            // refresh recency
            this.cache.delete(url);
            this.cache.set(url, cached);
            if (cached.notFound) throw new MusicBrainzError("MusicBrainz: not found", 404);
            return structuredClone(cached.value);
        }

        let pending = this.inFlight.get(url);
        if (!pending) {
            pending = this.fetchWithRetry(url)
                .then((value) => {
                    this.remember(url, { expires: this.options.now() + ttlMs, value });
                    return value;
                })
                .catch((error) => {
                    if (error instanceof MusicBrainzError && error.status === 404) {
                        this.remember(url, { expires: this.options.now() + this.options.notFoundTtlMs, notFound: true });
                    }
                    throw error;
                })
                .finally(() => this.inFlight.delete(url));
            this.inFlight.set(url, pending);
        }
        // every caller gets its own copy: the callers edit what they receive
        return structuredClone(await pending);
    }

    private remember(url: string, entry: CacheEntry): void {
        this.cache.delete(url);
        this.cache.set(url, entry);
        while (this.cache.size > this.options.maxCacheEntries) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }
    }

    /** Reserves the next slot of the global limiter and waits for it. */
    private async takeTurn(): Promise<void> {
        const now = this.options.now();
        const slot = Math.max(now, this.nextSlot);
        if (slot - now > this.options.maxQueueWaitMs) {
            throw new MusicBrainzError("MusicBrainz request queue is full, try again later", 503, true);
        }
        this.nextSlot = slot + this.options.minIntervalMs;
        if (slot > now) await this.options.sleep(slot - now);
    }

    private assertBreakerClosed(): void {
        const now = this.options.now();
        if (this.openUntil === 0) return;
        if (now < this.openUntil) {
            throw new MusicBrainzError("MusicBrainz is unavailable (circuit open), try again later", 503, true);
        }
        // cooldown over: let exactly one probe through (half-open)
        if (this.probing) throw new MusicBrainzError("MusicBrainz is unavailable (circuit probing), try again later", 503, true);
        this.probing = true;
    }

    private recordSuccess(): void {
        this.consecutiveFailures = 0;
        this.openUntil = 0;
        this.probing = false;
    }

    private recordFailure(): void {
        this.consecutiveFailures++;
        if (this.probing || this.consecutiveFailures >= this.options.breakerThreshold) {
            this.openUntil = this.options.now() + this.options.breakerCooldownMs;
        }
        this.probing = false;
    }

    private async fetchWithRetry(url: string): Promise<unknown> {
        this.assertBreakerClosed();

        let lastError: MusicBrainzError | null = null;
        let lastRetryAfter: number | undefined;
        for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
            if (attempt > 0) {
                const backoff = this.options.retryBaseMs * 2 ** (attempt - 1);
                const wait = Math.max(backoff, (lastRetryAfter ?? 0) * 1000);
                await this.options.sleep(wait);
            }
            await this.takeTurn();

            lastRetryAfter = undefined;
            try {
                const response = await this.options.transport(url, { userAgent: this.options.userAgent, timeoutMs: this.options.timeoutMs });
                lastRetryAfter = response.retryAfter;

                if (response.status >= 200 && response.status < 300) {
                    this.recordSuccess();
                    return response.body;
                }

                const message = (response.body as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
                // the request itself is wrong or points at nothing: not an outage, not worth retrying
                if (response.status === 400 || response.status === 404) {
                    this.recordSuccess();
                    throw new MusicBrainzError(`MusicBrainz: ${message}`, response.status);
                }
                lastError = new MusicBrainzError(`MusicBrainz: ${message}`, response.status === 429 ? 429 : 503, true);
            } catch (error) {
                if (error instanceof MusicBrainzError && !error.retryable) throw error;
                lastError = error instanceof MusicBrainzError
                    ? error
                    : new MusicBrainzError(`MusicBrainz request failed: ${(error as Error).message}`, 503, true);
            }
        }

        this.recordFailure();
        throw lastError ?? new MusicBrainzError("MusicBrainz request failed", 503, true);
    }
}
