// central SQLite connection + schema setup for all Nafyn databases
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dataDir = join(process.cwd(), ".data");

let usersDb: Database.Database | null = null;
let requestsDb: Database.Database | null = null;
let librariesDb: Database.Database | null = null;

function open(fileName: string): Database.Database {
    if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
    }

    const db = new Database(join(dataDir, fileName));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
}

export function getUsersDb(): Database.Database {
    if (!usersDb) usersDb = open("users.db");
    return usersDb;
}

export function getRequestsDb(): Database.Database {
    if (!requestsDb) requestsDb = open("requests.db");
    return requestsDb;
}

export function getLibrariesDb(): Database.Database {
    if (!librariesDb) librariesDb = open("libraries.db");
    return librariesDb;
}

// creates every DB (if missing) and ensures their tables exist, based on the `NafynUser`/`NafynRequest`/media entities
export function initDatabases(): void {
    const users = getUsersDb();
    users.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            passwordHash TEXT NOT NULL,
            displayName TEXT,
            avatar TEXT,
            permissions INTEGER NOT NULL DEFAULT 0,
            lastFm TEXT,
            discogs TEXT
        );
    `);

    const requests = getRequestsDb();
    requests.exec(`
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            musicbrainzId TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('album', 'track')),
            status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'searching', 'downloading', 'processing', 'completed', 'failed')),
            requestedBy TEXT,
            title TEXT,
            artistName TEXT,
            coverArt TEXT,
            createdAt INTEGER NOT NULL,
            updatedAt INTEGER NOT NULL
        );
    `);

    const libraries = getLibrariesDb();
    libraries.exec(`
        CREATE TABLE IF NOT EXISTS media (
            id TEXT PRIMARY KEY,
            musicbrainzId TEXT NOT NULL,
            title TEXT NOT NULL,
            artistName TEXT NOT NULL,
            artistMbid TEXT,
            album TEXT,
            albumId TEXT,
            albumType TEXT CHECK(albumType IN ('album', 'ep')),
            coverArt TEXT,
            releaseDate INTEGER,
            duration INTEGER NOT NULL,
            label TEXT,
            fingerprint TEXT,
            amId TEXT,
            addedAt INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_media_musicbrainzId ON media(musicbrainzId);

        CREATE TABLE IF NOT EXISTS library_entries (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            mediaId TEXT NOT NULL REFERENCES media(id),
            filePath TEXT NOT NULL,
            addedAt INTEGER NOT NULL,
            UNIQUE(userId, mediaId)
        );

        CREATE INDEX IF NOT EXISTS idx_library_entries_userId ON library_entries(userId);
    `);

    // migration: albumId was added after media's initial release, existing DBs need it backfilled
    const mediaColumns = libraries.prepare(`PRAGMA table_info(media)`).all() as { name: string }[];
    if (!mediaColumns.some((c) => c.name === "albumId")) {
        libraries.exec(`ALTER TABLE media ADD COLUMN albumId TEXT`);
    }

    // migration: amId (Apple Music relation) was added after media's initial release, existing DBs need it backfilled
    if (!mediaColumns.some((c) => c.name === "amId")) {
        libraries.exec(`ALTER TABLE media ADD COLUMN amId TEXT`);
    }

    // migration: title/artistName/coverArt were added after requests' initial release, existing DBs need them backfilled
    const requestColumns = requests.prepare(`PRAGMA table_info(requests)`).all() as { name: string }[];
    if (!requestColumns.some((c) => c.name === "title")) {
        requests.exec(`ALTER TABLE requests ADD COLUMN title TEXT`);
    }
    if (!requestColumns.some((c) => c.name === "artistName")) {
        requests.exec(`ALTER TABLE requests ADD COLUMN artistName TEXT`);
    }
    if (!requestColumns.some((c) => c.name === "coverArt")) {
        requests.exec(`ALTER TABLE requests ADD COLUMN coverArt TEXT`);
    }
}
