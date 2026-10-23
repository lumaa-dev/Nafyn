// One spelling of a cover URL for everything that leaves the API: `/api/v1/art/{type}/{id}/{size}`.
//
// Cover Art Archive URLs are what gets stored and what webhooks / APNs need (public and absolute), but a client
// of /api/v1 must never be sent to the archive itself - it takes 10-20 s cold and answers without any auth.
// Rather than every endpoint remembering to convert, this rewrites the JSON body of every /api/v1 response.
// GET /api/v1/art/.. is skipped (it answers with an image), and Subsonic's /rest never carries a URL at all.
import { rewriteCoverUrls } from "../utils/coverUrl";

export default defineNitroPlugin((nitroApp) => {
    nitroApp.hooks.hook("beforeResponse", (event, response) => {
        const path = event.path;
        if (!path.startsWith("/api/v1/") || path.startsWith("/api/v1/art/")) return;
        const body = response.body;
        if (body === null || typeof body !== "object") return;
        response.body = rewriteCoverUrls(body);
    });
});
