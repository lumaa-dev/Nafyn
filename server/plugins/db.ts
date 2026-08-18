import { statSync } from "node:fs";
import { initDatabases, getLibrariesDb } from "../core/db";
import { findAnyLibraryEntryForMedia } from "../core/library";

// one-time backfill for media rows written before `fileSize` existed
async function backfillMediaFileSizes(): Promise<void> {
    const db = getLibrariesDb();
    const rows = await db.prepare(`SELECT id FROM media WHERE fileSize IS NULL`).all() as { id: string }[];
    if (rows.length === 0) return;

    for (const { id } of rows) {
        const entry = await findAnyLibraryEntryForMedia(id);
        if (!entry) continue;
        try {
            await db.prepare(`UPDATE media SET fileSize = ? WHERE id = ?`).run(statSync(entry.filePath).size, id);
        } catch {
            // file missing on disk, leave fileSize null
        }
    }
}

export default defineNitroPlugin(async () => {
    await initDatabases();
    await backfillMediaFileSizes();
});
