// Only catches expiry (JWT exp claim); revocation still needs the server round-trip in app.vue.
export function isTokenExpired(token: string | null | undefined): boolean {
    if (!token) return true;

    const jwt = token.startsWith("Bearer ") ? token.slice(7) : token;
    const parts = jwt.split(".");
    if (parts.length !== 3) return true;

    try {
        const payload = JSON.parse(decodeBase64Url(parts[1]!));
        if (typeof payload.exp !== "number") return true;
        return Date.now() >= payload.exp * 1000;
    } catch {
        return true;
    }
}

function decodeBase64Url(segment: string): string {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    if (typeof atob === "function") return atob(base64);
    return Buffer.from(base64, "base64").toString();
}

export function useAuthToken() {
    const rawCookie = useCookie("nafynToken");

    const token = computed<string | null>(() => {
        const value = rawCookie.value ?? null;
        if (isTokenExpired(value)) return null;
        return value;
    });

    return { token, rawCookie };
}
