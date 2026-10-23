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
// the archive routinely needs 10-20 s on a cold image, so this has to outlast that; it covers the whole exchange
// (every redirect hop and the body), not each hop on its own
const FETCH_TIMEOUT_MS = 45_000;

export type CoverFetchResult =
    | { kind: "ok", response: Response }
    // the archive answered and has no such image (404/410, or a redirect leading nowhere usable)
    | { kind: "missing" }
    // couldn't tell: timeout, network error, 5xx, 429, a redirect off the allowlist. Worth trying again later
    | { kind: "error", reason: string };

// fetches an allowlisted cover URL, following redirects by hand so every hop is re-checked against the
// allowlist. `redirect: "follow"` only ever vetted the *first* URL: whatever that host answered with a
// Location header was fetched on trust. Also bounded in time, so a stalled upstream can't pin the request (and
// the client connection waiting on it) open indefinitely. Tells "the archive has no such cover" apart from
// "couldn't reach it", because the first is worth remembering and the second is not.
export async function fetchCoverArtResult(rawUrl: string): Promise<CoverFetchResult> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { kind: "missing" };
    }

    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isAllowedCoverArtUrl(url.href)) return { kind: "error", reason: `redirect to a host that is not allowed (${url.hostname})` };

        let response: Response;
        try {
            response = await fetch(url, { redirect: "manual", signal });
        } catch (error) {
            return { kind: "error", reason: `${url.hostname}: ${error instanceof Error ? error.message : error}` };
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) return { kind: "error", reason: `${url.hostname}: redirect without a location` };
            try {
                url = new URL(location, url);
            } catch {
                return { kind: "error", reason: `${url.hostname}: unusable redirect location` };
            }
            continue;
        }

        if (response.ok && response.body) return { kind: "ok", response };
        if (response.status === 404 || response.status === 410) return { kind: "missing" };
        return { kind: "error", reason: `${url.hostname}: HTTP ${response.status}` };
    }

    return { kind: "error", reason: "too many redirects" };
}

// same fetch for callers that only care whether they got an image: null on any doubt
export async function fetchCoverArt(rawUrl: string): Promise<Response | null> {
    const result = await fetchCoverArtResult(rawUrl);
    return result.kind === "ok" ? result.response : null;
}
