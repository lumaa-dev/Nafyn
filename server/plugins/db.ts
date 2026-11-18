import { stat } from "node:fs/promises";
import { initDatabases, getLibrariesDb } from "../core/db";
import { findAnyFilePathsForMedia } from "../core/library";

// one-time backfill for media rows written before `fileSize` existed. Runs after boot, not during it: a row
// whose file is gone keeps its NULL and is looked at again on every start, which must never delay one
async function backfillMediaFileSizes(): Promise<void> {
    const db = getLibrariesDb();
    const rows = await db.prepare(`SELECT id FROM media WHERE fileSize IS NULL`).all() as { id: string }[];
    if (rows.length === 0) return;

    const paths = await findAnyFilePathsForMedia(rows.map((row) => row.id));
    for (const [id, filePath] of paths) {
        try {
            await db.prepare(`UPDATE media SET fileSize = ? WHERE id = ?`).run((await stat(filePath)).size, id);
        } catch {
            // file missing on disk, leave fileSize null
        }
    }
}

export default defineNitroPlugin(async () => {
    // `nuxt build` boots the server bundle to prerender @nuxt/content's dump: no database, no timers, no logs there
    // (it used to migrate whatever MySQL .env pointed at, and the open pool kept the build from ever exiting)
    if (import.meta.prerender) return;
    await initDatabases();
    backfillMediaFileSizes().catch((err) => console.warn("[db] fileSize backfill failed:", err));
});
