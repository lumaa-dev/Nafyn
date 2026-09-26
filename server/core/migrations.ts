// ordered, idempotent schema migrations.
//
// Nafyn's original schema setup is `initDatabases()` in db.ts: one big pile of CREATE TABLE IF NOT EXISTS.
// That works exactly once per table and then stops - IF NOT EXISTS skips the *whole* statement, so adding a
// column to an existing install is a no-op that fails silently on every machine except a fresh one. This
// runner is the escape hatch: an append-only list of small, individually idempotent steps, each recorded in
// `schema_migrations` once applied.
//
// Rules for anything added to MIGRATIONS below:
//   1. Never edit or reorder a migration that has shipped. Append a new one instead.
//   2. Every migration must be safe to run twice (guard with the *Exists helpers or IF NOT EXISTS). MySQL
//      does not roll DDL back, so a migration that dies halfway must be re-runnable from where it stopped -
//      the `schema_migrations` row is a fast-path skip, not the safety mechanism.
//   3. One statement per `conn.query()`. Never route DDL through `Db.exec()`, which splits on ";" and would
//      cut a statement in half at the first semicolon inside a string literal or comment.
import type { PoolConnection } from "mysql2/promise";
import { getConnection } from "./db";
import { resolveTableOptions } from "./insightsSchema";

export interface Migration {
    id: string,
    up: (conn: PoolConnection) => Promise<void>
}

// MySQL advisory lock name. Connection-scoped, which is why the runner holds one dedicated connection for
// its whole life instead of going through the pool statement by statement.
const LOCK_NAME = "nafyn_migrations";
const LOCK_TIMEOUT_SECONDS = 30;

// SECURITY: table/column/index names are compared as *values* against information_schema rather than being
// concatenated into SQL. Every one of these helpers is called with hard-coded literals today, but building
// identifiers by string concatenation is exactly how a future caller with a dynamic name introduces DDL
// injection - so the parameterized shape is the one that gets to exist.
export async function tableExists(conn: PoolConnection, table: string): Promise<boolean> {
    const [rows] = await conn.execute(
        `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
        [table]
    );
    return (rows as unknown[]).length > 0;
}

export async function columnExists(conn: PoolConnection, table: string, column: string): Promise<boolean> {
    const [rows] = await conn.execute(
        `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
        [table, column]
    );
    return (rows as unknown[]).length > 0;
}

export async function indexExists(conn: PoolConnection, table: string, index: string): Promise<boolean> {
    const [rows] = await conn.execute(
        `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
        [table, index]
    );
    return (rows as unknown[]).length > 0;
}

// append-only; see the rules at the top of this file
const MIGRATIONS: Migration[] = [
    {
        // Baseline marker. The insights tables themselves are created by createInsightsTables() (which runs
        // before this) - this records that an install has been through the insights schema at least once, so
        // later migrations can assume those tables exist.
        id: "2026-08-27-insights-baseline",
        up: async () => {}
    },
    {
        // `play_events` is queried two ways: "everything this user played in a window" (covered by
        // idx_pe_user_time) and "how much of X did this user play" (covered by the per-entity indexes). The
        // retention sweep walks created_at across all users, which neither covers.
        id: "2026-08-27-play-events-created-index",
        up: async (conn) => {
            if (!await tableExists(conn, "play_events")) return;
            if (await indexExists(conn, "play_events", "idx_pe_created")) return;
            await conn.query(`ALTER TABLE play_events ADD INDEX idx_pe_created (created_at)`);
        }
    },
    {
        // manually imported tracks + user-edited metadata.
        //   `source`         - 'soulseek' for the download pipeline's rows, 'manual' for user uploads
        //   `trackNumber`    - previously only ever written into the audio file's own tags, never stored
        //   `hasCustomCover` - a cover image uploaded by a user, served from .data/covers/<mediaId>.webp
        //                      instead of `coverArt` (which stays a Cover Art Archive URL, see utils/coverArt.ts)
        id: "2026-08-29-manual-media",
        up: async (conn) => {
            if (!await columnExists(conn, "media", "source")) {
                await conn.query(`ALTER TABLE media ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'soulseek'`);
            }
            if (!await columnExists(conn, "media", "trackNumber")) {
                await conn.query(`ALTER TABLE media ADD COLUMN trackNumber INT NULL`);
            }
            if (!await columnExists(conn, "media", "hasCustomCover")) {
                await conn.query(`ALTER TABLE media ADD COLUMN hasCustomCover TINYINT(1) NOT NULL DEFAULT 0`);
            }
        }
    },
    {
        // user-supplied lyrics, kept out of `media` so a row with no custom lyrics costs nothing and the
        // (potentially long) text never rides along on every library listing query. ON DELETE CASCADE so
        // deleting the last owner's entry - which deletes the media row - takes the lyrics with it.
        id: "2026-08-29-media-lyrics",
        up: async (conn) => {
            if (await tableExists(conn, "media_lyrics")) return;
            // mediaId's charset/collation must match media.id exactly or the FK creation fails with
            // ER_FK_INCOMPATIBLE_COLUMNS (a fresh install defaults to utf8mb4_general_ci, same as `media`,
            // but a database that predates Nafyn can leave `media` on a different collation - see
            // resolveTableOptions in insightsSchema.ts for the same issue on the insights tables).
            const tableOptions = await resolveTableOptions(conn);
            await conn.query(`
                CREATE TABLE media_lyrics (
                    mediaId VARCHAR(36) PRIMARY KEY,
                    format VARCHAR(8) NOT NULL DEFAULT 'plain',
                    content MEDIUMTEXT NOT NULL,
                    updatedAt BIGINT NOT NULL,
                    CONSTRAINT fk_media_lyrics_media FOREIGN KEY (mediaId) REFERENCES media(id) ON DELETE CASCADE
                ) ${tableOptions}
            `);
        }
    },
    {
        // Align the insights tables' collation with `media`.
        //
        // They were originally created with a hardcoded utf8mb4_general_ci. On an install whose database
        // predates Nafyn (so `CREATE DATABASE ... COLLATE utf8mb4_general_ci` was skipped by IF NOT EXISTS)
        // `media` can be utf8mb4_unicode_ci instead, and then the rollup's `m.id = pe.track_id` join fails
        // every single time with ER_CANT_AGGREGATE_2COLLATIONS - no statistics are ever produced, while the
        // raw events pile up looking perfectly healthy.
        //
        // CONVERT TO CHARACTER SET rewrites the table, which is why this skips any table already matching.
        // On a fresh install every table is created correctly and this is a no-op.
        id: "2026-09-13-insights-collation-align",
        up: async (conn) => {
            const target = await resolveTableOptions(conn);
            const match = /DEFAULT CHARSET=([A-Za-z0-9_]+) COLLATE=([A-Za-z0-9_]+)/.exec(target);
            if (!match) return;

            const [, charset, collation] = match as unknown as [string, string, string];

            for (const table of INSIGHTS_TABLES) {
                if (!await tableExists(conn, table)) continue;

                const [rows] = await conn.execute(
                    `SELECT TABLE_COLLATION AS c FROM information_schema.TABLES
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                    [table]
                );
                const current = (rows as { c: string | null }[])[0]?.c;
                if (!current || current === collation) continue;

                // table name is from the hard-coded list above; charset/collation are validated by the
                // regex. Neither can be a placeholder in this position.
                await conn.query(`ALTER TABLE \`${table}\` CONVERT TO CHARACTER SET ${charset} COLLATE ${collation}`);
                console.info(`[insights] converted ${table} from ${current} to ${collation}`);
            }
        }
    }
];

/** every table owned by the insights feature, for schema-wide maintenance like the collation alignment above */
const INSIGHTS_TABLES = [
    "play_events",
    "user_insight_settings",
    "user_entity_stats_daily",
    "user_hour_stats_daily",
    "user_entity_stats_monthly",
    "user_entity_stats_yearly",
    "user_replay_playlists",
    "user_year_snapshots",
    "insight_job_runs"
];

async function appliedIds(conn: PoolConnection): Promise<Set<string>> {
    const [rows] = await conn.query(`SELECT id FROM schema_migrations`);
    return new Set((rows as { id: string }[]).map((r) => r.id));
}

export async function runMigrations(): Promise<void> {
    const conn = await getConnection();

    try {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id VARCHAR(191) PRIMARY KEY,
                applied_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);

        // Two Nafyn processes booting at once (a restart overlapping the old process, or a second replica)
        // would otherwise race on the same ALTER. GET_LOCK returns 1 on acquire, 0 on timeout, NULL on error.
        const [lockRows] = await conn.execute(`SELECT GET_LOCK(?, ?) AS acquired`, [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
        const acquired = (lockRows as { acquired: number | null }[])[0]?.acquired;
        if (acquired !== 1) {
            // Another process is mid-migration. It will finish the work; carrying on without the lock is the
            // one thing that must not happen, so bail loudly rather than run DDL concurrently.
            throw new Error(`Could not acquire the '${LOCK_NAME}' lock within ${LOCK_TIMEOUT_SECONDS}s - another instance is migrating`);
        }

        try {
            const done = await appliedIds(conn);

            for (const migration of MIGRATIONS) {
                if (done.has(migration.id)) continue;

                await migration.up(conn);
                await conn.execute(
                    `INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE applied_at = applied_at`,
                    [migration.id, Date.now()]
                );
            }
        } finally {
            await conn.execute(`SELECT RELEASE_LOCK(?)`, [LOCK_NAME]).catch(() => {});
        }
    } finally {
        conn.release();
    }
}
