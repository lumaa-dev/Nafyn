// central MySQL connection + schema setup for all Nafyn databases
import mysql from "mysql2/promise";
import { createInsightsTables, resolveTableOptions } from "./insightsSchema";
import { runMigrations } from "./migrations";

let pool: mysql.Pool | null = null;

function config() {
    return {
        host: process.env.MYSQL_HOST ?? "localhost",
        port: Number(process.env.MYSQL_PORT ?? 3306),
        user: process.env.MYSQL_USER ?? "root",
        password: process.env.MYSQL_PASSWORD ?? "",
        database: process.env.MYSQL_DATABASE ?? "nafyn"
    };
}

function getPool(): mysql.Pool {
    if (!pool) {
        pool = mysql.createPool({
            ...config(),
            namedPlaceholders: true,
            charset: "utf8mb4_general_ci",
            // MySQL DATE/DATETIME/TIMESTAMP values have no zone of their own, so mysql2 interprets them in
            // the Node process's local zone unless told otherwise. The listening-insights tables are the
            // first to use those types, and an hour-of-day histogram that silently shifts when the host's
            // TZ changes is worse than useless - pin both directions to UTC. Inert for every pre-existing
            // table, which stores epoch-ms in BIGINT columns.
            timezone: "Z",
            waitForConnections: true,
            connectionLimit: 10
        });

        // ...and pin the SERVER session to UTC too. These are two different things, and conflating them is
        // a genuine trap: mysql2's `timezone` option only governs how the *driver* converts JS Date objects
        // to and from strings. It does not touch MySQL's session `time_zone`, which is what server-side
        // functions like FROM_UNIXTIME() and TIMESTAMP storage conversion actually use.
        //
        // With the session left on SYSTEM, a host running anything other than UTC makes the insights window
        // query silently match nothing: play_events rows are written as UTC strings, while
        // `started_at >= FROM_UNIXTIME(:fromMs / 1000)` resolves the bound in the server's local zone. The
        // rows are all present and correct, the rollup just never sees them, and every statistic reads zero.
        //
        // Enqueued from the 'connection' event, which fires as soon as a physical connection is created.
        // mysql2 runs one command at a time per connection in enqueue order, so this is guaranteed to
        // execute before any query the pool later hands that connection - there is no race here.
        pool.on("connection", (connection) => {
            connection.query("SET time_zone = '+00:00'");
        });
    }
    return pool;
}

// treats a single object argument as named params (`:name`), anything else as positional (`?`) params,
// mirroring better-sqlite3's `.get(obj)` vs `.get(a, b)` overloads so the callers stay unchanged
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bind(params: unknown[]): any {
    if (params.length === 1 && params[0] !== null && typeof params[0] === "object" && !Array.isArray(params[0])) {
        return params[0];
    }
    return params;
}

// mysql2's `.execute()` (server-side prepared statements) rejects `LIMIT ?`/`OFFSET ?` placeholders with
// "Incorrect arguments to mysqld_stmt_execute" (ER_WRONG_ARGUMENTS) - a known mysql2/MySQL protocol
// limitation, not something bind() above can work around. Every caller that needs LIMIT/OFFSET has to inline
// a validated integer straight into the SQL string instead; this is what makes that safe to do.
export function sqlInt(n: number): number {
    const int = Math.trunc(n);
    if (!Number.isFinite(int) || int < 0) {
        throw new Error(`Invalid LIMIT/OFFSET value: ${n}`);
    }
    return int;
}

// thin better-sqlite3-shaped wrapper over a mysql2 pool; `.get`/`.all`/`.run` are async now (MySQL is async),
// but the call shape (`db.prepare(sql).get(id)`) is otherwise identical to the old SQLite code
class Statement {
    constructor(private db: mysql.Pool, private sql: string) {}

    async get<T = unknown>(...params: unknown[]): Promise<T | undefined> {
        const [rows] = await this.db.execute(this.sql, bind(params));
        return (rows as T[])[0];
    }

    async all<T = unknown>(...params: unknown[]): Promise<T[]> {
        const [rows] = await this.db.execute(this.sql, bind(params));
        return rows as T[];
    }

    async run(...params: unknown[]): Promise<{ changes: number, lastInsertRowid: number }> {
        const [result] = await this.db.execute(this.sql, bind(params)) as [mysql.ResultSetHeader, unknown];
        return { changes: result.affectedRows ?? 0, lastInsertRowid: Number(result.insertId ?? 0) };
    }
}

class Db {
    constructor(private pool: mysql.Pool) {}

    prepare(sql: string): Statement {
        return new Statement(this.pool, sql);
    }

    // multi-statement DDL, used for schema setup
    async exec(sql: string): Promise<void> {
        const conn = await this.pool.getConnection();
        try {
            for (const statement of sql.split(";")) {
                if (statement.trim()) await conn.query(statement);
            }
        } finally {
            conn.release();
        }
    }
}

let db: Db | null = null;

function getDb(): Db {
    if (!db) db = new Db(getPool());
    return db;
}

// runs `fn` inside a single MySQL transaction on a dedicated connection, committing on success and
// rolling back on throw; replaces better-sqlite3's synchronous `db.transaction(fn)()`
export async function withTransaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
    const conn = await getPool().getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (err) {
        // a rollback that itself fails (connection already dropped, for instance) must not replace the
        // original error - that error is the one that explains what actually went wrong
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// hands out a dedicated pooled connection; the caller MUST release it. Needed for work that is
// connection-scoped rather than statement-scoped - MySQL's GET_LOCK/RELEASE_LOCK (see migrations.ts) is
// held by the connection that took it, so it can't go through the pool one statement at a time.
export async function getConnection(): Promise<mysql.PoolConnection> {
    return await getPool().getConnection();
}

export function getUsersDb(): Db {
    return getDb();
}

export function getRequestsDb(): Db {
    return getDb();
}

export function getLibrariesDb(): Db {
    return getDb();
}

// creates the database (if missing) and ensures every table exists, based on the `NafynUser`/`NafynRequest`/media entities
export async function initDatabases(): Promise<void> {
    const { database, ...serverConfig } = config();

    // the pool connects with a database selected, so the database itself must exist first
    const bootstrap = await mysql.createConnection(serverConfig);
    try {
        await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    } finally {
        await bootstrap.end();
    }

    const users = getUsersDb();
    await users.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(36) PRIMARY KEY,
            username VARCHAR(255) NOT NULL UNIQUE,
            passwordHash VARCHAR(255) NOT NULL,
            displayName VARCHAR(255),
            avatar TEXT,
            permissions INT NOT NULL DEFAULT 0,
            lastFm TEXT,
            discogs TEXT
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            \`key\` VARCHAR(255) PRIMARY KEY,
            \`value\` TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS register_tokens (
            id VARCHAR(36) PRIMARY KEY,
            token VARCHAR(255) NOT NULL UNIQUE,
            createdBy VARCHAR(36) NOT NULL,
            createdAt BIGINT NOT NULL,
            expiresAt BIGINT NOT NULL,
            usedAt BIGINT
        );

        -- user-generated, revocable app passwords: stored as plaintext (not bcrypt-hashed like the account
        -- password) because Subsonic's token-auth challenge (t = md5(secret + s)) requires the server to
        -- hold something it can re-hash and compare against, which a one-way bcrypt hash can never allow.
        -- Also usable directly as a password (p=) by clients that don't do the challenge.
        CREATE TABLE IF NOT EXISTS api_tokens (
            id VARCHAR(36) PRIMARY KEY,
            userId VARCHAR(36) NOT NULL,
            name VARCHAR(100),
            token VARCHAR(64) NOT NULL UNIQUE,
            createdAt BIGINT NOT NULL,
            lastUsedAt BIGINT,
            INDEX idx_api_tokens_userId (userId)
        );

        -- per-user display preferences, kept off \`users\` for the same reason as user_insight_settings:
        -- updateUser() is a fixed-column read-modify-write, so a new column there needs both its SELECT-merge
        -- and its SET clause touched or the value silently reverts on the next profile edit. Absent row means
        -- both preferences default on.
        CREATE TABLE IF NOT EXISTS user_appearance_settings (
            userId VARCHAR(36) PRIMARY KEY,
            showFileSize TINYINT(1) NOT NULL DEFAULT 1,
            showDuration TINYINT(1) NOT NULL DEFAULT 1
        );

        -- per-user playback preferences (Settings -> Playback), off \`users\` for the same reason as above.
        -- Absent row means crossfade on, 3000 ms.
        CREATE TABLE IF NOT EXISTS user_playback_settings (
            userId VARCHAR(36) PRIMARY KEY,
            crossfadeEnabled TINYINT(1) NOT NULL DEFAULT 1,
            crossfadeMs INT NOT NULL DEFAULT 3000
        );

        -- one row per login, id doubles as the signed JWT's \`jti\` claim so a token can be revoked by deleting
        -- (soft, via revokedAt) its matching row. No FK to users, same informal-reference convention as
        -- api_tokens/register_tokens above.
        CREATE TABLE IF NOT EXISTS sessions (
            id VARCHAR(36) PRIMARY KEY,
            userId VARCHAR(36) NOT NULL,
            userAgent TEXT,
            ip VARCHAR(64),
            createdAt BIGINT NOT NULL,
            lastSeenAt BIGINT NOT NULL,
            revokedAt BIGINT NULL,
            expiresAt BIGINT NOT NULL,
            INDEX idx_sessions_userId (userId)
        );

        -- per-user Nafyn Unity opt-out (Settings -> Sessions), off \`users\` for the same reason as the other
        -- per-user settings tables above. Absent row means Unity enabled.
        CREATE TABLE IF NOT EXISTS user_unity_settings (
            userId VARCHAR(36) PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 1
        );

        -- WebAuthn passkeys, an alternative to password login. No FK to users, same informal-reference
        -- convention as api_tokens/sessions. publicKey/transports hold no secret (a public key, and a hint
        -- list like "usb,internal"), so they are plain text, not hashed.
        CREATE TABLE IF NOT EXISTS passkeys (
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
        );

        -- outbound webhooks. userId NULL is an instance-wide ("global") webhook, managed under
        -- MANAGE_WEBHOOKS, anything else is one user's own. \`url\` is a credential in its own right (a Discord
        -- or Slack webhook URL is all it takes to post into that channel), so it is never exported or echoed
        -- back in full.
        CREATE TABLE IF NOT EXISTS webhooks (
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
        );

        -- APNs tokens registered by the Nafyn iOS app. One row per (token, kind), bound to the login
        -- (sessionId = JWT jti) that registered it, so logging that device out or revoking its session stops
        -- its pushes too. kind separates the regular alert token from the per-attributes-type push-to-start
        -- tokens Live Activities and Now Playing remote sessions use.
        CREATE TABLE IF NOT EXISTS apn_devices (
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
        );

        -- per-activity APNs update tokens: a running Live Activity (request progress, release countdown) or a
        -- Now Playing remote session hands the app a token that only addresses that one activity/session.
        -- Bound to the registering login like apn_devices, and swept with it.
        CREATE TABLE IF NOT EXISTS apn_activity_tokens (
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
        );

        -- "notify me when this comes out" for unreleased albums/tracks. releaseAt is the UTC instant of local
        -- midnight on releaseDate in the subscriber's own timezone, which is when the notification goes out.
        CREATE TABLE IF NOT EXISTS release_subscriptions (
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
        );

        -- pins: albums, playlists and tracks a user keeps at hand (Library home, top of Tracks). refId is the
        -- track's media id, the album's release-group MBID or the playlist id. No limit per user, and a pin whose
        -- target is gone is pruned the next time the list is read. (No semicolons in these comments: exec() splits on them.)
        CREATE TABLE IF NOT EXISTS user_pins (
            id VARCHAR(36) PRIMARY KEY,
            userId VARCHAR(36) NOT NULL,
            kind VARCHAR(16) NOT NULL,
            refId VARCHAR(64) NOT NULL,
            pinnedAt BIGINT NOT NULL,
            UNIQUE KEY uq_user_pin (userId, kind, refId),
            INDEX idx_user_pin_order (userId, pinnedAt)
        );

        -- playlist imports: a list of tracks another service described, resolved to MusicBrainz and requested
        -- one by one in the background. imports.userId and the items' title/artist are personal data: both
        -- tables are in eraseAccount() and buildAccountExport(). No FK to users, items go with their import.
        CREATE TABLE IF NOT EXISTS imports (
            id VARCHAR(36) PRIMARY KEY,
            userId VARCHAR(36) NOT NULL,
            source VARCHAR(32) NULL,
            name VARCHAR(200) NULL,
            status VARCHAR(16) NOT NULL,
            total INT NOT NULL,
            processed INT NOT NULL DEFAULT 0,
            createdAt BIGINT NOT NULL,
            updatedAt BIGINT NOT NULL,
            INDEX idx_imports_user (userId, createdAt),
            INDEX idx_imports_status (status, updatedAt)
        );

        CREATE TABLE IF NOT EXISTS import_items (
            importId VARCHAR(36) NOT NULL,
            position INT NOT NULL,
            isrc VARCHAR(12) NULL,
            title VARCHAR(300) NOT NULL,
            artist VARCHAR(300) NOT NULL,
            album VARCHAR(300) NULL,
            duration INT NULL,
            status VARCHAR(24) NOT NULL,
            attempts INT NOT NULL DEFAULT 0,
            musicbrainzId VARCHAR(36) NULL,
            requestId VARCHAR(36) NULL,
            via VARCHAR(8) NULL,
            message VARCHAR(255) NULL,
            PRIMARY KEY (importId, position)
        );
    `);

    const requests = getRequestsDb();
    await requests.exec(`
        CREATE TABLE IF NOT EXISTS requests (
            id VARCHAR(36) PRIMARY KEY,
            musicbrainzId VARCHAR(36) NOT NULL,
            type VARCHAR(16) NOT NULL CHECK(type IN ('album', 'track')),
            status VARCHAR(16) NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'searching', 'downloading', 'processing', 'completed', 'failed', 'denied')),
            requestedBy VARCHAR(36),
            title TEXT,
            artistName TEXT,
            coverArt TEXT,
            createdAt BIGINT NOT NULL,
            updatedAt BIGINT NOT NULL
        );
    `);

    const libraries = getLibrariesDb();
    await libraries.exec(`
        CREATE TABLE IF NOT EXISTS media (
            id VARCHAR(36) PRIMARY KEY,
            musicbrainzId VARCHAR(36) NOT NULL,
            title TEXT NOT NULL,
            artistName TEXT NOT NULL,
            artistMbid VARCHAR(64),
            album TEXT,
            albumId VARCHAR(64),
            albumType VARCHAR(16) CHECK(albumType IN ('album', 'ep')),
            coverArt TEXT,
            releaseDate BIGINT,
            duration INT NOT NULL,
            label TEXT,
            fingerprint TEXT,
            amId VARCHAR(64),
            fileSize BIGINT,
            -- 'soulseek' for the download pipeline's rows, 'manual' for user uploads
            source VARCHAR(16) NOT NULL DEFAULT 'soulseek',
            -- position within its medium (a two-disc album has two track 1s), see discNumber
            trackNumber INT NULL,
            -- the medium's position (NULL = disc 1) and its own title (NULL = shown as "Disc N")
            discNumber INT NULL,
            discTitle TEXT NULL,
            -- a cover image uploaded by a user, served from .data/covers/<mediaId>.webp instead of coverArt
            hasCustomCover TINYINT(1) NOT NULL DEFAULT 0,
            addedAt BIGINT NOT NULL,
            INDEX idx_media_musicbrainzId (musicbrainzId)
        );

        CREATE TABLE IF NOT EXISTS library_entries (
            id VARCHAR(36) PRIMARY KEY,
            userId VARCHAR(36) NOT NULL,
            mediaId VARCHAR(36) NOT NULL,
            filePath TEXT NOT NULL,
            addedAt BIGINT NOT NULL,
            UNIQUE KEY uq_library_user_media (userId, mediaId),
            INDEX idx_library_entries_userId (userId),
            CONSTRAINT fk_library_media FOREIGN KEY (mediaId) REFERENCES media(id)
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id VARCHAR(36) PRIMARY KEY,
            ownerId VARCHAR(36) NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            privacy VARCHAR(16) NOT NULL DEFAULT 'private' CHECK(privacy IN ('public', 'private')),
            image TEXT,
            sortMode VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK(sortMode IN ('manual', 'title', 'artist', 'addedBy', 'duration')),
            createdAt BIGINT NOT NULL,
            updatedAt BIGINT NOT NULL,
            INDEX idx_playlists_ownerId (ownerId)
        );

        CREATE TABLE IF NOT EXISTS playlist_members (
            id VARCHAR(36) PRIMARY KEY,
            playlistId VARCHAR(36) NOT NULL,
            userId VARCHAR(36) NOT NULL,
            addedAt BIGINT NOT NULL,
            UNIQUE KEY uq_playlist_member (playlistId, userId),
            INDEX idx_playlist_members_playlistId (playlistId),
            INDEX idx_playlist_members_userId (userId),
            CONSTRAINT fk_playlist_members_playlist FOREIGN KEY (playlistId) REFERENCES playlists(id)
        );

        CREATE TABLE IF NOT EXISTS playlist_entries (
            id VARCHAR(36) PRIMARY KEY,
            playlistId VARCHAR(36) NOT NULL,
            mediaId VARCHAR(36) NOT NULL,
            addedBy VARCHAR(36) NOT NULL,
            position INT NOT NULL,
            addedAt BIGINT NOT NULL,
            INDEX idx_playlist_entries_playlistId (playlistId),
            CONSTRAINT fk_playlist_entries_playlist FOREIGN KEY (playlistId) REFERENCES playlists(id),
            CONSTRAINT fk_playlist_entries_media FOREIGN KEY (mediaId) REFERENCES media(id)
        );

        CREATE TABLE IF NOT EXISTS recently_played (
            id VARCHAR(36) PRIMARY KEY,
            userId VARCHAR(36) NOT NULL,
            type VARCHAR(16) NOT NULL CHECK(type IN ('track', 'album', 'playlist')),
            refId VARCHAR(64) NOT NULL,
            playedAt BIGINT NOT NULL,
            UNIQUE KEY uq_recently_played (userId, type, refId),
            INDEX idx_recently_played_userId_playedAt (userId, playedAt DESC)
        );
    `);

    // listening-insights tables live in their own module (they need one-statement-at-a-time execution that
    // `exec()`'s split-on-";" can't give them), and migrations run last so they can assume every
    // CREATE TABLE above has already happened
    await createMediaChildTables();
    await createInsightsTables();
    await runMigrations();
}

// the tables that hang off `media` with a foreign key. Their charset/collation must match media.id exactly or
// the FK creation fails with ER_FK_INCOMPATIBLE_COLUMNS: a fresh install defaults to utf8mb4_general_ci, same
// as `media`, but a database that predates Nafyn can leave `media` on a different collation (see
// resolveTableOptions in insightsSchema.ts), hence one statement at a time with the options taken from media.
async function createMediaChildTables(): Promise<void> {
    const conn = await getConnection();
    try {
        const tableOptions = await resolveTableOptions(conn);

        // user-supplied lyrics, kept out of `media` so a row with no custom lyrics costs nothing and the
        // (potentially long) text never rides along on every library listing query. ON DELETE CASCADE so
        // deleting the last owner's entry - which deletes the media row - takes the lyrics with it.
        await conn.query(`
            CREATE TABLE IF NOT EXISTS media_lyrics (
                mediaId VARCHAR(36) PRIMARY KEY,
                format VARCHAR(8) NOT NULL DEFAULT 'plain',
                content MEDIUMTEXT NOT NULL,
                updatedAt BIGINT NOT NULL,
                CONSTRAINT fk_media_lyrics_media FOREIGN KEY (mediaId) REFERENCES media(id) ON DELETE CASCADE
            ) ${tableOptions}
        `);

        // every other identifier a `media` row is known by, so "does this user already have this song?" holds
        // when MusicBrainz names the same song differently:
        //   kind 'mbid' - recording MBIDs besides media.musicbrainzId (MusicBrainz merges duplicate recordings
        //                 and the merged-away MBID then resolves to another one)
        //   kind 'isrc' - the recording's ISRCs; two MBIDs carrying the same ISRC are the same master
        // ON DELETE CASCADE so the identifiers go with the row when its last owner deletes it.
        await conn.query(`
            CREATE TABLE IF NOT EXISTS media_identifiers (
                mediaId VARCHAR(36) NOT NULL,
                kind VARCHAR(8) NOT NULL CHECK(kind IN ('mbid', 'isrc')),
                value VARCHAR(64) NOT NULL,
                PRIMARY KEY (mediaId, kind, value),
                INDEX idx_media_identifiers_value (kind, value),
                CONSTRAINT fk_media_identifiers_media FOREIGN KEY (mediaId) REFERENCES media(id) ON DELETE CASCADE
            ) ${tableOptions}
        `);
    } finally {
        conn.release();
    }
}
