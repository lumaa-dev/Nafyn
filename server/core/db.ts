// central MySQL connection + schema setup for all Nafyn databases
import mysql from "mysql2/promise";

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
            waitForConnections: true,
            connectionLimit: 10
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
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
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
    `);

    const requests = getRequestsDb();
    await requests.exec(`
        CREATE TABLE IF NOT EXISTS requests (
            id VARCHAR(36) PRIMARY KEY,
            musicbrainzId VARCHAR(36) NOT NULL,
            type VARCHAR(16) NOT NULL CHECK(type IN ('album', 'track')),
            status VARCHAR(16) NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'searching', 'downloading', 'processing', 'completed', 'failed')),
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
}
