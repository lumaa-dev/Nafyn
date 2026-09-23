// schema for importing a library from another streaming service (Settings -> Import).
//
// Three tables: one row per import job, one per thing found in the source library (track, album or
// artist), and one per source playlist so the matching Nafyn playlist can be created lazily - only once a
// track from it actually lands, so a playlist nothing could be matched for never shows up empty.
//
// Provider access tokens are deliberately NOT stored anywhere in here: they live in memory only
// (server/utils/transfer/sessions.ts) for the few minutes it takes to read the source library, and every
// later stage (matching, downloading) works purely off the rows below.
import { getRequestsDb } from "./db";

export async function createTransferTables(): Promise<void> {
    // no ";" inside any statement body below - Db.exec() splits on it
    await getRequestsDb().exec(`
        CREATE TABLE IF NOT EXISTS transfer_jobs (
            id VARCHAR(36) PRIMARY KEY,
            userId VARCHAR(36) NOT NULL,
            provider VARCHAR(16) NOT NULL,
            status VARCHAR(16) NOT NULL CHECK(status IN ('fetching', 'matching', 'downloading', 'completed', 'failed', 'cancelled')),
            error TEXT,
            totalItems INT NOT NULL DEFAULT 0,
            truncated TINYINT NOT NULL DEFAULT 0,
            createdAt BIGINT NOT NULL,
            updatedAt BIGINT NOT NULL,
            finishedAt BIGINT,
            INDEX idx_transfer_jobs_user (userId, createdAt),
            INDEX idx_transfer_jobs_status (status, createdAt)
        );

        CREATE TABLE IF NOT EXISTS transfer_playlists (
            id VARCHAR(36) PRIMARY KEY,
            jobId VARCHAR(36) NOT NULL,
            externalId VARCHAR(255),
            title TEXT NOT NULL,
            description TEXT,
            nafynPlaylistId VARCHAR(36),
            INDEX idx_transfer_playlists_job (jobId),
            CONSTRAINT fk_transfer_playlists_job FOREIGN KEY (jobId) REFERENCES transfer_jobs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS transfer_items (
            id VARCHAR(36) PRIMARY KEY,
            jobId VARCHAR(36) NOT NULL,
            position INT NOT NULL,
            kind VARCHAR(16) NOT NULL CHECK(kind IN ('track', 'album', 'artist')),
            source VARCHAR(16) NOT NULL CHECK(source IN ('liked', 'playlist', 'album', 'artist', 'file')),
            playlistRef VARCHAR(36),
            externalId VARCHAR(255),
            title TEXT,
            artistName TEXT,
            albumName TEXT,
            isrc VARCHAR(16),
            upc VARCHAR(20),
            durationMs INT,
            status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'matching', 'matched', 'requested', 'completed', 'failed', 'skipped')),
            failReason VARCHAR(32),
            alreadyOwned TINYINT NOT NULL DEFAULT 0,
            musicbrainzId VARCHAR(36),
            matchedBy VARCHAR(8),
            requestId VARCHAR(36),
            updatedAt BIGINT NOT NULL,
            INDEX idx_transfer_items_job (jobId, position),
            INDEX idx_transfer_items_status (status, jobId),
            CONSTRAINT fk_transfer_items_job FOREIGN KEY (jobId) REFERENCES transfer_jobs(id) ON DELETE CASCADE
        );
    `);
}
