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
