import { statSync } from "node:fs";
import { initDatabases, getLibrariesDb } from "../core/db";
import { findAnyLibraryEntryForMedia } from "../core/library";

// one-time backfill for media rows written before `fileSize` existed
function backfillMediaFileSizes(): void {
    const db = getLibrariesDb();
    const rows = db.prepare(`SELECT id FROM media WHERE fileSize IS NULL`).all() as { id: string }[];
    if (rows.length === 0) return;

    const update = db.prepare(`UPDATE media SET fileSize = ? WHERE id = ?`);
    for (const { id } of rows) {
        const entry = findAnyLibraryEntryForMedia(id);
        if (!entry) continue;
        try {
            update.run(statSync(entry.filePath).size, id);
        } catch {
            // file missing on disk, leave fileSize null
        }
    }
}

export default defineNitroPlugin(() => {
    initDatabases();
    backfillMediaFileSizes();
});
