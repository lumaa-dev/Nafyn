// security response headers for every route.
//
// `helmet` is in package.json but was never wired into Nitro (it's Express middleware, and Nitro isn't
// Express), so none of these were being sent. This sets them directly on the H3 event instead.
export default defineEventHandler((event) => {
    const path = event.path ?? "";

    // a WebSocket upgrade never carries a normal response head - writing headers onto it does nothing
    // useful and risks interfering with the handshake
    if (path.startsWith("/ws")) return;

    const isApi = path.startsWith("/api") || path.startsWith("/rest");

    // stops a browser MIME-sniffing a JSON/text response into HTML or script - the trick that turns a
    // reflected string in an API response into stored XSS on this origin
    setResponseHeader(event, "X-Content-Type-Options", "nosniff");
    // no framing at all: Nafyn is never meant to be embedded, and this kills clickjacking outright
    setResponseHeader(event, "X-Frame-Options", "DENY");
    // never leak the full URL (which for streams/avatars carries a `?token=` JWT) to a third-party origin
    setResponseHeader(event, "Referrer-Policy", "no-referrer");
    setResponseHeader(event, "Cross-Origin-Opener-Policy", "same-origin");
    setResponseHeader(event, "Cross-Origin-Resource-Policy", "same-origin");
    setResponseHeader(event, "Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");

    // HSTS only over an actual TLS connection - sending it over plain http pins a scheme the deployment
    // may not serve, and browsers ignore it there anyway
    const proto = getHeader(event, "x-forwarded-proto");
    const isTls = proto === "https" || Boolean((event.node?.req?.socket as { encrypted?: boolean } | undefined)?.encrypted);
    if (isTls) {
        setResponseHeader(event, "Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    if (isApi) {
        // API/Subsonic responses are pure data - nothing in them should ever execute, load a subresource,
        // or be framed. `sandbox` additionally neutralises the jsonp endpoint's script response if a
        // browser is ever navigated straight to it.
        setResponseHeader(event, "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
        // per-user data must never be cached by a shared proxy
        if (!getResponseHeader(event, "Cache-Control")) {
            setResponseHeader(event, "Cache-Control", "no-store");
        }
        return;
    }

    // HTML pages. Nuxt's SSR hydration payload is an inline <script>, and its style handling is inline
    // too, so 'unsafe-inline' is unavoidable here without adopting a nonce-emitting CSP module. What this
    // policy still buys: no 'unsafe-eval', no third-party script origins, no plugins/objects, no framing,
    // and a locked `base-uri`/`form-action` so an injected <base> or <form> can't redirect anything.
    setResponseHeader(event, "Content-Security-Policy", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join("; "));
});
