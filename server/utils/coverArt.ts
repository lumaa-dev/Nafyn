// SECURITY: cover art URLs stored on a media row are fetched server-side (Subsonic's getCoverArt proxies
// them). A server-side fetch of a stored URL is an SSRF sink: if a URL ever reaches the `media` table from
// anywhere other than the hardcoded Cover Art Archive template - a future import path, a manual DB edit, a
// bug - it could point at `http://169.254.169.254/`, an internal admin panel, or `file:`/`gopher:`. This
// allowlist keeps the proxy pointed at the one host it is actually meant to reach.
const ALLOWED_COVER_ART_HOSTS = new Set([
    "coverartarchive.org",
    "ia801504.us.archive.org",
    "archive.org"
]);

export function isAllowedCoverArtUrl(rawUrl: string): boolean {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }

    // https only: plain http would let a network-position attacker swap the bytes, and every other scheme
    // (file:, data:, gopher:, ...) is a different class of sink entirely
    if (url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();
    if (ALLOWED_COVER_ART_HOSTS.has(host)) return true;
    // archive.org serves the actual image bytes off rotating *.us.archive.org nodes after a redirect
    return host.endsWith(".archive.org");
}

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;

// fetches an allowlisted cover URL, following redirects by hand so every hop is re-checked against the
// allowlist. `redirect: "follow"` only ever vetted the *first* URL: whatever that host answered with a
// Location header was fetched on trust. Also bounded in time, so a stalled upstream can't pin the request (and
// the client connection waiting on it) open indefinitely. Returns null on any doubt.
export async function fetchCoverArt(rawUrl: string): Promise<Response | null> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isAllowedCoverArtUrl(url.href)) return null;

        let response: Response;
        try {
            response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        } catch {
            return null;
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) return null;
            url = new URL(location, url);
            continue;
        }

        return response.ok && response.body ? response : null;
    }

    return null;
}
