// The Nafyn app's own address for a web page (`nafyn://...`), so a phone opening a Nafyn link lands in the app
// (app/plugins/appHandoff.client.ts). Only the screens the app's URL scheme knows have one: an album, a track and
// the requests (NafynApp's `DeepLink`); every other page stays on the web. Pure, so it runs under `bun test`.

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `nafyn://album/<mbid>` for `/a/<mbid>`, `nafyn://track/<mbid>` for `/t/<mbid>`, `nafyn://requests`; else null. */
export function appLinkFor(path: string): string | null {
    const parts = path.split(/[?#]/, 1)[0]!.split("/").filter((part) => part.length > 0);
    const [first, second, ...rest] = parts;
    if (first === "requests" && second === undefined) return "nafyn://requests";
    if (rest.length > 0 || !second || !MBID_RE.test(second)) return null;
    if (first === "a") return `nafyn://album/${second.toLowerCase()}`;
    if (first === "t") return `nafyn://track/${second.toLowerCase()}`;
    return null;
}

/**
 * The page a visit was really for: the login page carries the one a logged-out visitor was sent away from as
 * `?from=` (app.vue), anything else is itself. Only a path on this site (`/...`, never `//host`) is taken.
 */
export function requestedPath(path: string, from: unknown): string {
    if (path === "/login" && typeof from === "string" && from.startsWith("/") && !from.startsWith("//")) return from;
    return path;
}

/** A phone or tablet, the devices the app exists for (iPadOS presents itself as a Mac with a touch screen). */
export function isMobileDevice(userAgent: string, maxTouchPoints: number): boolean {
    if (/\b(iPhone|iPod|iPad|Android)\b/i.test(userAgent)) return true;
    return /\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1;
}
