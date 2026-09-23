// the one fetch wrapper every import provider goes through (no third-party SDKs - plain HTTP only)

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_WAIT_MS = 30_000;

export class TransferHttpError extends Error {
    constructor(public status: number, public host: string, detail: string) {
        super(`${host} answered ${status}${detail ? `: ${detail}` : ""}`);
    }
}

export function transferSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// SECURITY: a paging cursor ("next" URL) comes back from the upstream service. It is followed only when it
// still points at one of that provider's own API hosts, over https - so a compromised or confused upstream
// can't turn the import into a request forger against anything else (including hosts on Nafyn's own network).
export function assertTransferHost(url: string, allowedHosts: string[]): URL {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error("Invalid upstream URL");
    }
    if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.hostname)) {
        throw new Error(`Refusing to call unexpected host ${parsed.hostname}`);
    }
    return parsed;
}

function retryAfterMs(res: Response, attempt: number): number {
    const header = res.headers.get("retry-after");
    const seconds = header ? Number(header) : NaN;
    const wait = Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt;
    return Math.min(Math.max(wait, 500), MAX_RETRY_WAIT_MS);
}

// fetches JSON, retrying rate limits (429, honouring Retry-After) and transient 5xx/network errors
export async function transferFetch<T = unknown>(url: string, allowedHosts: string[], init: RequestInit = {}): Promise<T> {
    const { hostname } = assertTransferHost(url, allowedHosts);

    for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
            res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        } catch (err) {
            if (attempt + 1 >= MAX_ATTEMPTS) throw err;
            await transferSleep(1000 * 2 ** attempt);
            continue;
        }

        if ((res.status === 429 || res.status >= 500) && attempt + 1 < MAX_ATTEMPTS) {
            await transferSleep(retryAfterMs(res, attempt));
            continue;
        }

        if (!res.ok) {
            // only a short, single-line slice of the body - it ends up in logs and in the job's error field
            const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
            throw new TransferHttpError(res.status, hostname, detail);
        }

        if (res.status === 204) return {} as T;
        return await res.json() as T;
    }
}

// POSTs an application/x-www-form-urlencoded body, used by every OAuth token endpoint
export async function transferPostForm<T = unknown>(url: string, allowedHosts: string[], form: Record<string, string>, headers: Record<string, string> = {}): Promise<T> {
    return await transferFetch<T>(url, allowedHosts, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers },
        body: new URLSearchParams(form).toString()
    });
}

// "PT3M21S" -> 201000
export function isoDurationToMs(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
    if (!match) return null;
    const [, d, h, m, s] = match;
    const ms = ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0)) * 60_000 + Number(s ?? 0) * 1000;
    return ms > 0 ? Math.round(ms) : null;
}

export function str(value: unknown): string | null {
    if (typeof value === "number") return String(value);
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function num(value: unknown): number | null {
    const n = typeof value === "string" ? Number(value) : value;
    return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}
