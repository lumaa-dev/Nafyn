// absolute links back into this instance, for places that leave the browser (webhooks, push notifications).
// Optional: without NAFYN_PUBLIC_URL there is no reliable way to know how the outside world reaches Nafyn
// (reverse proxies, ports, LAN vs public hostnames), so links are simply left out rather than guessed.

export function publicBaseUrl(): string | null {
    const raw = process.env.NAFYN_PUBLIC_URL?.trim();
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        return url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
        return null;
    }
}

/** `/a/<id>` -> `https://music.example.com/a/<id>`, or null when no public URL is configured */
export function publicUrl(path: string): string | null {
    const base = publicBaseUrl();
    if (!base) return null;
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** absolute http(s) URLs pass through, relative ones are resolved against NAFYN_PUBLIC_URL */
export function absoluteUrl(maybeRelative: string | null | undefined): string | null {
    if (!maybeRelative) return null;
    if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
    return maybeRelative.startsWith("/") ? publicUrl(maybeRelative) : null;
}
