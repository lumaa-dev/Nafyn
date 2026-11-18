// picks up the playlist imports a restart interrupted (server/core/imports.ts): their items are in the database,
// only the in-process worker went with the old process. Same single-instance assumption as the download queue.
//
// Nitro runs plugins in alphabetical filename order, so db.ts (which creates the tables) has always finished
// before this one starts.
import { resumeImports } from "~~/server/core/imports";

export default defineNitroPlugin(() => {
    // `nuxt build` boots the server bundle to prerender @nuxt/content's dump: no database, no timers, no logs there
    // (it used to migrate whatever MySQL .env pointed at, and the open pool kept the build from ever exiting)
    if (import.meta.prerender) return;
    if (process.env.NAFYN_IMPORT_WORKER === "false") {
        console.info("[imports] worker disabled by NAFYN_IMPORT_WORKER=false");
        return;
    }
    // a little after boot, like the other schedulers: the database plugin has set up the schema by then
    const timer = setTimeout(() => {
        resumeImports().catch((error) => console.error("[imports] could not resume imports:", error));
    }, 15_000);
    timer.unref?.();
});
