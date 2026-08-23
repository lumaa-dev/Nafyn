// resolves the real client IP for rate-limiting / whitelisting.
//
// SECURITY: `X-Forwarded-For` is attacker-controlled unless a reverse proxy the operator actually runs
// rewrites it. Trusting it unconditionally (h3's `getRequestIP(event, { xForwardedFor: true })`, which
// returns the *first*, i.e. most client-controlled, entry) lets anyone defeat every per-IP rate limit by
// sending a fresh random `X-Forwarded-For` on each request. So the header is only read when the operator
// declares how many proxies sit in front of Nafyn, via `TRUST_PROXY`, and then only the hop that proxy
// itself appended is used.
import type { H3Event } from "h3";

// TRUST_PROXY: number of reverse proxies in front of Nafyn ("1" for a single nginx/Caddy/Traefik in front,
// "2" behind Cloudflare + nginx, ...). Unset/"0"/"false" means Nafyn is directly exposed and the header is
// ignored entirely. "true" is accepted as an alias for 1.
function trustedProxyHops(): number {
    const raw = (process.env.TRUST_PROXY ?? "0").trim().toLowerCase();
    if (raw === "true") return 1;
    if (raw === "" || raw === "false") return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// strips an IPv6-mapped IPv4 prefix and any :port suffix so the same client always keys the same bucket
export function normalizeIp(ip: string): string {
    let value = ip.trim();
    if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
    // "1.2.3.4:5678" - only ever a host:port pair for IPv4, an IPv6 address has many colons
    const colons = value.split(":").length - 1;
    if (colons === 1) value = value.split(":")[0]!;
    return value.toLowerCase() || "unknown";
}

export function getClientIP(event: H3Event): string {
    const hops = trustedProxyHops();

    if (hops > 0) {
        const forwarded = getHeader(event, "x-forwarded-for");
        if (forwarded) {
            const chain = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
            // the last entry was appended by the proxy nearest to us and is the only one it vouches for;
            // walking back `hops` entries lands on the client as seen by the outermost trusted proxy.
            // Anything further left in the chain is whatever the client chose to send and is never used.
            const candidate = chain[Math.max(chain.length - hops, 0)];
            if (candidate) return normalizeIp(candidate);
        }
    }

    return normalizeIp(getRequestIP(event) ?? "unknown");
}
