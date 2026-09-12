// Loads the user's listening-history opt-in once, at app start.
//
// This is what the feature was missing: the opt-in flag was only ever fetched by the Settings → Privacy tab
// and the Insights page, so on every other page - including every page you actually play music from - it sat
// at its default and capture was skipped. A client plugin runs on every app load, whichever page you land
// on, which is the only place this belongs.
//
// Client-only (`.client.ts`): it reads the auth cookie and talks to an authenticated endpoint, neither of
// which belongs in a server render.
import { syncHistorySetting } from "~/composables/usePlayTracking";

export default defineNuxtPlugin(() => {
    // deliberately not awaited - insights are a background concern and must never delay first paint or
    // block navigation. Capture treats "not yet known" as "keep queueing" (see usePlayTracking), so a listen
    // that starts before this resolves is still recorded.
    void syncHistorySetting();
});
