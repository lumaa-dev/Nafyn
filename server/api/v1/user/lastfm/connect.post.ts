import { lastfmCredentials } from "~~/server/core/lastfmAccounts";
import { LASTFM_AUTH_URL } from "~~/server/utils/lastfmApi";
import { signPurposeToken } from "~~/server/utils/jwt";
import { publicBaseUrl } from "~~/server/utils/publicUrl";

defineRouteMeta({
    openAPI: {
        description: "Start connecting a Last.fm account: returns the last.fm page to open. Once the user allows Nafyn there, Last.fm sends the browser back to GET /api/v1/lastfm/callback, which stores the session and redirects to the web settings (`client: web`) or to `nafyn://lastfm?status=connected|error` (`client: app`, for ASWebAuthenticationSession). The link is valid for 10 minutes",
        tags: ["user"],
        operationId: "connectLastfm",
        requestBody: {
            required: false,
            content: { "application/json": { schema: { type: "object", properties: { client: { type: "string", enum: ["web", "app"], default: "web" } } } } }
        },
        responses: {
            "200": { description: "", content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" } } } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "503": { description: "Last.fm is not configured on this instance", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const credentials = lastfmCredentials();
    if (!credentials) throw createError({ statusCode: 503, statusMessage: "Last.fm is not configured on this instance" });

    const body = await readBody(event).catch(() => null) as { client?: unknown } | null;
    const client = body?.client === "app" ? "app" : "web";

    // the callback must be reachable by the browser that opens last.fm: NAFYN_PUBLIC_URL, else how this
    // request reached us (through the reverse proxy)
    const base = publicBaseUrl() ?? getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin;
    const state = signPurposeToken("lastfm", { sub: userId, client }, "10m");
    const callback = `${base}/api/v1/lastfm/callback?state=${encodeURIComponent(state)}`;

    return { url: `${LASTFM_AUTH_URL}?api_key=${encodeURIComponent(credentials.apiKey)}&cb=${encodeURIComponent(callback)}` };
});
