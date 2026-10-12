// serves the privacy notice document (content/<locale>/privacy.md) to app/pages/privacy.vue.
//
// WHY THIS ROUTE EXISTS: @nuxt/content v3 answers `queryCollection()` from a WASM SQLite build *in the
// browser* whenever the call happens client-side - which is exactly what a client-side navigation into
// /privacy is. The CSP in server/middleware/security-headers.ts sends `script-src 'self' 'unsafe-inline'`
// with no `wasm-unsafe-eval`, so the browser blocks the WASM compile, the query throws, and the page
// renders its "could not be loaded" fallback (a direct page load worked, because that query ran on the
// server). Loosening the CSP app-wide to allow WASM - and shipping the whole content database to every
// visitor - would be a bad trade for one static document, so the query stays on the server and the page
// fetches this instead.
//
// Public on purpose: GDPR art. 13 means the notice has to be readable before an account exists, so there
// is no requireAuthToken() here. It serves one build-time document and nothing user-specific.
import { queryCollection } from "@nuxt/content/server";

// the locale arrives from the client and is interpolated into the document path below, so it is matched
// against a strict shape first rather than trusted. Anything else falls back to English.
const LOCALE_PATTERN = /^[a-z]{2}$/;
const FALLBACK_LOCALE = "en";

defineRouteMeta({
    openAPI: {
        description: "The privacy notice document for a locale, as parsed markdown. Public - the notice has to be readable before an account exists. Falls back to the English document when the requested locale has no translation.",
        tags: ["content"],
        operationId: "getPrivacyNotice",
        parameters: [
            {
                name: "locale",
                in: "query",
                required: false,
                description: "Two-letter locale code. Anything else is treated as `en`.",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "The parsed document, or `null` when no notice could be found at all",
                content: { "application/json": { schema: { type: "object", nullable: true } } }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const requested = getQuery(event).locale;
    const locale = typeof requested === "string" && LOCALE_PATTERN.test(requested) ? requested : FALLBACK_LOCALE;

    const doc = await queryCollection(event, "legal").path(`/${locale}/privacy`).first()
        ?? (locale === FALLBACK_LOCALE
            ? null
            : await queryCollection(event, "legal").path(`/${FALLBACK_LOCALE}/privacy`).first());

    // the notice is a build-time document, identical for every caller, so it is the one thing under /api
    // worth letting a client hold on to briefly. security-headers.ts only defaults Cache-Control when a
    // route hasn't set it, so this wins over its `no-store`.
    setResponseHeader(event, "Cache-Control", "public, max-age=300");

    return doc ?? null;
});
