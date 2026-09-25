// request body size ceiling for every route.
//
// SECURITY: h3's readBody()/readMultipartFormData() buffer the *entire* request body in memory before a
// handler ever sees it, and nothing upstream of them caps its size. So without this, anyone - no account
// needed, POST /api/v1/auth/login is public - could stream a multi-gigabyte body at the server and have it
// held in RAM until the process died. Size checks inside the handlers (MAX_IMPORT_BYTES, the 16 MB image
// cap, ...) run far too late to help: by then the bytes are already buffered.
//
// Two rules make the check airtight rather than best-effort:
//   - a body must declare its length up front. Node's HTTP parser then refuses to hand over more bytes than
//     `Content-Length` announces, so a declared size can't be lied about. Every browser fetch/FormData/
//     sendBeacon body and every Subsonic client form post sends one.
//   - a chunked body (no length until it's over) is refused outright, since its size can only be learned by
//     buffering it - which is exactly what this exists to prevent.
const DEFAULT_LIMIT_BYTES = 1 * 1024 * 1024;
const IMAGE_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
// audio (MAX_IMPORT_BYTES, 200 MB) + an optional cover (16 MB) + multipart framing and metadata
const AUDIO_IMPORT_LIMIT_BYTES = 230 * 1024 * 1024;

const UUID = "[0-9a-fA-F-]{36}";
const LARGE_BODY_ROUTES: { method: string, pattern: RegExp, limit: number }[] = [
    { method: "POST", pattern: /^\/api\/v1\/library\/import$/, limit: AUDIO_IMPORT_LIMIT_BYTES },
    { method: "PUT", pattern: new RegExp(`^/api/v1/library/${UUID}/cover$`), limit: IMAGE_UPLOAD_LIMIT_BYTES },
    { method: "POST", pattern: /^\/api\/v1\/user\/avatar$/, limit: IMAGE_UPLOAD_LIMIT_BYTES },
    { method: "POST", pattern: new RegExp(`^/api/v1/users/${UUID}/avatar$`), limit: IMAGE_UPLOAD_LIMIT_BYTES },
    { method: "POST", pattern: new RegExp(`^/api/v1/playlist/${UUID}/image$`), limit: IMAGE_UPLOAD_LIMIT_BYTES }
];

function limitFor(method: string, path: string): number {
    for (const route of LARGE_BODY_ROUTES) {
        if (route.method === method && route.pattern.test(path)) return route.limit;
    }
    return DEFAULT_LIMIT_BYTES;
}

export default defineEventHandler((event) => {
    const method = event.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

    const transferEncoding = getHeader(event, "transfer-encoding");
    const rawLength = getHeader(event, "content-length");

    if (rawLength === undefined) {
        if (transferEncoding) {
            throw createError({ statusCode: 411, statusMessage: "Length Required" });
        }
        // no length and no chunking: HTTP/1.1 defines that as an empty body
        return;
    }

    if (!/^\d+$/.test(rawLength)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid Content-Length" });
    }

    const path = (event.path ?? "").split("?")[0] ?? "";
    if (Number(rawLength) > limitFor(method, path)) {
        throw createError({ statusCode: 413, statusMessage: "Request body is too large" });
    }
});
