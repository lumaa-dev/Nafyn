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

const ADMIN_HIGHEST_BIT_MIGRATION = "2026-10-18-admin-highest-permission-bit";

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
    },
    {
        // Nafyn Unity: one row per login, id doubles as the signed JWT's `jti` claim. No FK (same informal
        // reference convention as api_tokens/register_tokens).
        id: "2026-10-11-sessions",
        up: async (conn) => {
            if (await tableExists(conn, "sessions")) return;
            await conn.query(`
                CREATE TABLE sessions (
                    id VARCHAR(36) PRIMARY KEY,
                    userId VARCHAR(36) NOT NULL,
                    userAgent TEXT,
                    ip VARCHAR(64),
                    createdAt BIGINT NOT NULL,
                    lastSeenAt BIGINT NOT NULL,
                    revokedAt BIGINT NULL,
                    expiresAt BIGINT NOT NULL,
                    INDEX idx_sessions_userId (userId)
                )
            `);
        }
    },
    {
        // Nafyn Unity: per-user opt-out (Settings -> Sessions). Absent row means Unity enabled.
        id: "2026-10-11-unity-settings",
        up: async (conn) => {
            if (await tableExists(conn, "user_unity_settings")) return;
            await conn.query(`
                CREATE TABLE user_unity_settings (
                    userId VARCHAR(36) PRIMARY KEY,
                    enabled TINYINT(1) NOT NULL DEFAULT 1
                )
            `);
        }
    },
    {
        // WebAuthn passkeys, an alternative to password login (server/core/passkeys.ts). No FK to users,
        // same informal-reference convention as api_tokens/sessions above. publicKey/transports hold no
        // secret (a public key, and a hint list like "usb,internal"), so they're plain text, not hashed.
        id: "2026-10-11-passkeys",
        up: async (conn) => {
            if (await tableExists(conn, "passkeys")) return;
            await conn.query(`
                CREATE TABLE passkeys (
                    id VARCHAR(36) PRIMARY KEY,
                    userId VARCHAR(36) NOT NULL,
                    credentialId VARCHAR(255) NOT NULL UNIQUE,
                    publicKey TEXT NOT NULL,
                    counter BIGINT NOT NULL DEFAULT 0,
                    deviceType VARCHAR(16) NOT NULL,
                    backedUp TINYINT(1) NOT NULL DEFAULT 0,
                    transports VARCHAR(255),
                    label VARCHAR(100),
                    createdAt BIGINT NOT NULL,
                    lastUsedAt BIGINT NULL,
                    INDEX idx_passkeys_userId (userId)
                )
            `);
        }
    },
    {
        // a manager refusing a waiting request used to be recorded as "failed", indistinguishable from a
        // download the pipeline gave up on - which made "your request was denied" impossible to notify.
        // MySQL >= 8.0.16 and MariaDB enforce the inline CHECK, which has an engine-generated name
        // (`requests_chk_2` on MySQL, `status` on MariaDB), so it is looked up rather than guessed. An older
        // MySQL that parsed but never enforced CHECK has no row here, and there is nothing to widen.
        id: "2026-10-16-request-denied-status",
        up: async (conn) => {
            const [rows] = await conn.execute(`
                SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
                FROM information_schema.CHECK_CONSTRAINTS cc
                JOIN information_schema.TABLE_CONSTRAINTS tc
                  ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
                WHERE cc.CONSTRAINT_SCHEMA = DATABASE() AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'
            `, ["requests"]);

            for (const { name, clause } of rows as { name: string, clause: string }[]) {
                if (!clause.includes("searching")) continue; // the `type` CHECK, not the status one
                if (clause.includes("denied")) return;
                // the name came out of information_schema, but it still lands in DDL unquoted-by-placeholder,
                // so it is held to a plain identifier shape before being interpolated
                if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unexpected CHECK constraint name on requests: ${name}`);
                await conn.query(`ALTER TABLE requests DROP CONSTRAINT \`${name}\``);
            }

            await conn.query(`
                ALTER TABLE requests ADD CONSTRAINT chk_requests_status
                CHECK (status IN ('waiting', 'searching', 'downloading', 'processing', 'completed', 'failed', 'denied'))
            `);
        }
    },
    {
        // outbound webhooks (server/utils/webhook.ts). userId NULL is an instance-wide ("global") webhook,
        // managed under MANAGE_WEBHOOKS; anything else is one user's own. No FK to users, same informal-
        // reference convention as api_tokens/sessions. `url` is a credential in its own right (a Discord or
        // Slack webhook URL is all it takes to post into that channel), so it is never exported or echoed
        // back in full - see maskWebhookUrl().
        id: "2026-10-16-webhooks",
        up: async (conn) => {
            if (await tableExists(conn, "webhooks")) return;
            await conn.query(`
                CREATE TABLE webhooks (
                    id VARCHAR(36) PRIMARY KEY,
                    userId VARCHAR(36) NULL,
                    name VARCHAR(100) NOT NULL,
                    url TEXT NOT NULL,
                    format VARCHAR(16) NOT NULL,
                    events TEXT NULL,
                    enabled TINYINT(1) NOT NULL DEFAULT 1,
                    failureCount INT NOT NULL DEFAULT 0,
                    lastError TEXT NULL,
                    lastDeliveredAt BIGINT NULL,
                    createdAt BIGINT NOT NULL,
                    INDEX idx_webhooks_userId (userId)
                )
            `);
        }
    },
    {
        // APNs tokens registered by the Nafyn iOS app (server/utils/apn.ts). One row per (token), bound to the
        // login (`sessionId` = JWT jti) that registered it, so logging that device out or revoking its session
        // stops its pushes too. `kind` separates the regular alert token from the per-attributes-type
        // push-to-start tokens Live Activities and Now Playing remote sessions use. No FK to users.
        id: "2026-10-16-apn-devices",
        up: async (conn) => {
            if (await tableExists(conn, "apn_devices")) return;
            await conn.query(`
                CREATE TABLE apn_devices (
                    id VARCHAR(36) PRIMARY KEY,
                    userId VARCHAR(36) NOT NULL,
                    sessionId VARCHAR(36) NOT NULL,
                    token VARCHAR(255) NOT NULL,
                    kind VARCHAR(32) NOT NULL,
                    environment VARCHAR(16) NOT NULL,
                    deviceName VARCHAR(100) NULL,
                    events TEXT NULL,
                    createdAt BIGINT NOT NULL,
                    lastSeenAt BIGINT NOT NULL,
                    UNIQUE KEY uq_apn_devices_token_kind (token, kind),
                    INDEX idx_apn_devices_userId (userId),
                    INDEX idx_apn_devices_sessionId (sessionId)
                )
            `);
        }
    },
    {
        // per-activity APNs update tokens: a running Live Activity (request progress, release countdown) or a
        // Now Playing remote session hands the app a token that only addresses that one activity/session.
        // Bound to the registering login (sessionId = JWT jti) like apn_devices, and swept with it.
        id: "2026-10-16-apn-activity-tokens",
        up: async (conn) => {
            if (await tableExists(conn, "apn_activity_tokens")) return;
            await conn.query(`
                CREATE TABLE apn_activity_tokens (
                    id VARCHAR(36) PRIMARY KEY,
                    userId VARCHAR(36) NOT NULL,
                    sessionId VARCHAR(36) NOT NULL,
                    kind VARCHAR(16) NOT NULL,
                    refId VARCHAR(64) NOT NULL,
                    token VARCHAR(255) NOT NULL,
                    environment VARCHAR(16) NOT NULL,
                    createdAt BIGINT NOT NULL,
                    UNIQUE KEY uq_apn_activity (kind, refId, sessionId),
                    INDEX idx_apn_activity_userId (userId)
                )
            `);
        }
    },
    {
        // "notify me when this comes out" for unreleased albums/tracks (server/core/releaseSubscriptions.ts).
        // releaseAt is the UTC instant of local midnight on releaseDate in the subscriber's own timezone,
        // which is when the notification goes out. No FK to users.
        id: "2026-10-16-release-subscriptions",
        up: async (conn) => {
            if (await tableExists(conn, "release_subscriptions")) return;
            await conn.query(`
                CREATE TABLE release_subscriptions (
                    id VARCHAR(36) PRIMARY KEY,
                    userId VARCHAR(36) NOT NULL,
                    musicbrainzId VARCHAR(36) NOT NULL,
                    type VARCHAR(16) NOT NULL,
                    title TEXT NULL,
                    artistName TEXT NULL,
                    coverArt TEXT NULL,
                    releaseDate CHAR(10) NOT NULL,
                    timezone VARCHAR(64) NOT NULL,
                    releaseAt BIGINT NOT NULL,
                    activityStartedAt BIGINT NULL,
                    notifiedAt BIGINT NULL,
                    createdAt BIGINT NOT NULL,
                    UNIQUE KEY uq_release_sub (userId, musicbrainzId),
                    INDEX idx_release_sub_due (notifiedAt, releaseAt)
                )
            `);
        }
    },
    {
        // ADMIN is meant to be the highest permission bit, but MANAGE_WEBHOOKS was added above it (512). The two
        // trade places: 256 becomes MANAGE_WEBHOOKS and 512 becomes ADMIN, so every stored ADMIN (256) has to
        // become 512, and the other way round for anyone already given MANAGE_WEBHOOKS.
        //
        // A swap is its own inverse, so unlike every other migration this one is NOT safe to run twice - it
        // would hand every admin MANAGE_WEBHOOKS and nothing else. The schema_migrations row is therefore
        // written inside the same transaction as the UPDATE, so either both happen or neither does.
        id: ADMIN_HIGHEST_BIT_MIGRATION,
        up: async (conn) => {
            await conn.beginTransaction();
            try {
                await conn.query(`
                    UPDATE users
                    SET permissions = permissions - (permissions & 768) + IF(permissions & 256, 512, 0) + IF(permissions & 512, 256, 0)
                    WHERE (permissions & 768) <> 0
                `);
                await conn.execute(
                    `INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?) ON DUPLICATE KEY UPDATE applied_at = applied_at`,
                    [ADMIN_HIGHEST_BIT_MIGRATION, Date.now()]
                );
                await conn.commit();
            } catch (error) {
                await conn.rollback().catch(() => {});
                throw error;
            }
        }
    },
    {
        // every other identifier a `media` row is known by, so "does this user already have this song?" holds
        // when MusicBrainz names the same song differently:
        //   kind 'mbid' - recording MBIDs besides media.musicbrainzId. MusicBrainz merges duplicate recordings
        //                 and the merged-away MBID then resolves to another one, so the ID a file was
        //                 downloaded under is not necessarily the one a later request carries.
        //   kind 'isrc' - the recording's ISRCs; two MBIDs carrying the same ISRC are the same master.
        // ON DELETE CASCADE so the identifiers go with the row when its last owner deletes it.
        id: "2026-10-22-media-identifiers",
        up: async (conn) => {
            if (await tableExists(conn, "media_identifiers")) return;
            // same collation caveat as media_lyrics above
            const tableOptions = await resolveTableOptions(conn);
            await conn.query(`
                CREATE TABLE media_identifiers (
                    mediaId VARCHAR(36) NOT NULL,
                    kind VARCHAR(8) NOT NULL CHECK(kind IN ('mbid', 'isrc')),
                    value VARCHAR(64) NOT NULL,
                    PRIMARY KEY (mediaId, kind, value),
                    INDEX idx_media_identifiers_value (kind, value),
                    CONSTRAINT fk_media_identifiers_media FOREIGN KEY (mediaId) REFERENCES media(id) ON DELETE CASCADE
                ) ${tableOptions}
            `);
        }
    },
    {
        // multi-disc releases. `trackNumber` is the position *within* its medium (what MusicBrainz and every tag
        // format call "track"), so a two-disc album has two track 1s; `discNumber` + `discTitle` tell them apart.
        //   `discNumber` - the medium's position, NULL for rows that predate this (shown as disc 1)
        //   `discTitle`  - the medium's own title when MusicBrainz has one; NULL means "Disc N"
        id: "2026-10-26-media-disc",
        up: async (conn) => {
            if (!await columnExists(conn, "media", "discNumber")) {
                await conn.query(`ALTER TABLE media ADD COLUMN discNumber INT NULL`);
            }
            if (!await columnExists(conn, "media", "discTitle")) {
                await conn.query(`ALTER TABLE media ADD COLUMN discTitle TEXT NULL`);
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
