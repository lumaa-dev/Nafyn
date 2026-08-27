// schema for the listening-insights feature ("Your Music Year").
//
// Kept out of db.ts's initDatabases() because these statements go through `conn.query()` one at a time
// rather than `Db.exec()`, which splits its input on ";" and would cut any of the comments or CHECK bodies
// below in half. Same idempotence contract as the rest of the schema: CREATE TABLE IF NOT EXISTS only, with
// anything that needs to change an *existing* table living in migrations.ts instead.
//
// Type conventions here differ from the rest of Nafyn on purpose (CHAR(36) ids and TIMESTAMP(3) columns
// rather than VARCHAR(36) and BIGINT epoch-ms), because the feature spec fixes them. Two consequences worth
// knowing before touching any of this:
//
//   * Every table declares CHARSET/COLLATE explicitly. `play_events.track_id` joins `media.id VARCHAR(36)`,
//     and a collation mismatch between them either errors outright ("Illegal mix of collations") or, worse,
//     silently makes the index on media.id unusable and turns every insights query into a full table scan.
//     CHAR(36) vs VARCHAR(36) is fine; a collation difference is not.
//
//   * Comparing a TIMESTAMP column against the epoch-ms BIGINTs used elsewhere must convert the *constant*,
//     never the column: `WHERE started_at >= FROM_UNIXTIME(:fromMs / 1000)` uses the index,
//     `WHERE UNIX_TIMESTAMP(started_at) * 1000 >= :fromMs` does not.
//
// Note every TIMESTAMP column carries an explicit DEFAULT. Without one, MySQL's legacy
// explicit_defaults_for_timestamp=OFF behaviour silently attaches DEFAULT CURRENT_TIMESTAMP *and* ON UPDATE
// CURRENT_TIMESTAMP to the first TIMESTAMP column in a table - which would quietly rewrite `started_at`
// every time a row was touched.
import { getConnection } from "./db";

const STATEMENTS: string[] = [
    // ---- the append-only event store ----------------------------------------------------------------
    //
    // Immutable: rows are only ever inserted (INSERT IGNORE, keyed on a client-minted event_id so retries
    // and multi-device double-flushes collapse) and, on an explicit user request, deleted wholesale.
    //
    // There is deliberately NO foreign key to media(id). `deleteOrphanMediaRow()` hard-deletes media rows
    // when the last library entry referencing them goes away, and an FK here would either block that or
    // cascade a user's listening history into the void - both of which violate "library deletions must
    // never erase historical play data". The aggregate tables carry denormalized display_* snapshots so a
    // long-deleted track still renders correctly in an old summary.
    //
    // album_id/artist_id are VARCHAR(64), not CHAR(36), to match media.albumId/media.artistMbid. albumId in
    // particular carries the literal sentinel 'unknown-album' for tracks with no resolved release group, so
    // it is not always a UUID and must never be run through assertUuid().
    `CREATE TABLE IF NOT EXISTS play_events (
        event_id    CHAR(36) NOT NULL,
        user_id     CHAR(36) NOT NULL,
        track_id    CHAR(36) NOT NULL,
        album_id    VARCHAR(64) NOT NULL,
        artist_id   VARCHAR(64) NULL,
        playlist_id CHAR(36) NULL,
        started_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
        completed   TINYINT(1) NOT NULL DEFAULT 0,
        source      ENUM('library', 'playlist', 'album', 'track') NOT NULL,
        created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (event_id),
        KEY idx_pe_user_time (user_id, started_at),
        KEY idx_pe_user_track_time (user_id, track_id, started_at),
        KEY idx_pe_user_album_time (user_id, album_id, started_at),
        KEY idx_pe_user_artist_time (user_id, artist_id, started_at),
        KEY idx_pe_user_playlist_time (user_id, playlist_id, started_at),
        KEY idx_pe_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

    // ---- per-user opt-in ----------------------------------------------------------------------------
    //
    // A table of its own rather than a column on `users`, for two reasons. updateUser() is a fixed-column
    // read-modify-write, so a new column there has to be added to both its SELECT-merge and its SET clause -
    // miss either and the flag appears to save and silently reverts on the next profile edit. And keeping it
    // out of `users` keeps it out of rowToUser(), so a privacy setting can never leak through
    // /api/v1/user/me or the GET /api/v1/users listing.
    //
    // Absent row means disabled: listening history is strictly opt-in.
    `CREATE TABLE IF NOT EXISTS user_insight_settings (
        user_id           CHAR(36) NOT NULL,
        history_enabled   TINYINT(1) NOT NULL DEFAULT 0,
        enabled_at        TIMESTAMP(3) NULL DEFAULT NULL,
        disabled_at       TIMESTAMP(3) NULL DEFAULT NULL,
        tz_offset_minutes SMALLINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

    // ---- derived aggregates -------------------------------------------------------------------------
    //
    // Every user-facing surface reads from these, never from play_events. One row per
    // (user, bucket, entity type, entity) - so a single play writes up to four rows (its track, album,
    // artist and, when played from one, playlist), which is what makes album/artist/playlist rankings a
    // plain lookup rather than a join-and-group at request time.
    //
    // play_count is the raw count of qualifying plays; weighted_play_count applies the skip/partial
    // weighting from insightsScore.ts. total_duration_ms is always real wall-clock milliseconds played,
    // unweighted - "total listening minutes" means exactly that.
    `CREATE TABLE IF NOT EXISTS user_entity_stats_daily (
        user_id             CHAR(36) NOT NULL,
        bucket_date         DATE NOT NULL,
        entity_type         ENUM('track', 'album', 'artist', 'playlist') NOT NULL,
        entity_id           VARCHAR(64) NOT NULL,
        play_count          INT UNSIGNED NOT NULL DEFAULT 0,
        weighted_play_count DECIMAL(12,3) NOT NULL DEFAULT 0,
        total_duration_ms   BIGINT UNSIGNED NOT NULL DEFAULT 0,
        first_played_at     TIMESTAMP(3) NULL DEFAULT NULL,
        last_played_at      TIMESTAMP(3) NULL DEFAULT NULL,
        is_first_ever       TINYINT(1) NOT NULL DEFAULT 0,
        display_title       VARCHAR(255) NULL DEFAULT NULL,
        display_subtitle    VARCHAR(255) NULL DEFAULT NULL,
        display_cover       TEXT NULL DEFAULT NULL,
        PRIMARY KEY (user_id, bucket_date, entity_type, entity_id),
        KEY idx_uesd_user_type_date (user_id, entity_type, bucket_date),
        KEY idx_uesd_user_entity (user_id, entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

    // rank_in_bucket is 1-based and precomputed by the rollup jobs, so "top 10 artists in March" is an
    // index range scan rather than a sort over the user's whole month.
    `CREATE TABLE IF NOT EXISTS user_entity_stats_monthly (
        user_id             CHAR(36) NOT NULL,
        bucket_year         SMALLINT UNSIGNED NOT NULL,
        bucket_month        TINYINT UNSIGNED NOT NULL,
        entity_type         ENUM('track', 'album', 'artist', 'playlist') NOT NULL,
        entity_id           VARCHAR(64) NOT NULL,
        play_count          INT UNSIGNED NOT NULL DEFAULT 0,
        weighted_play_count DECIMAL(12,3) NOT NULL DEFAULT 0,
        total_duration_ms   BIGINT UNSIGNED NOT NULL DEFAULT 0,
        first_played_at     TIMESTAMP(3) NULL DEFAULT NULL,
        last_played_at      TIMESTAMP(3) NULL DEFAULT NULL,
        is_first_ever       TINYINT(1) NOT NULL DEFAULT 0,
        score               DOUBLE NOT NULL DEFAULT 0,
        rank_in_bucket      INT UNSIGNED NOT NULL DEFAULT 0,
        display_title       VARCHAR(255) NULL DEFAULT NULL,
        display_subtitle    VARCHAR(255) NULL DEFAULT NULL,
        display_cover       TEXT NULL DEFAULT NULL,
        PRIMARY KEY (user_id, bucket_year, bucket_month, entity_type, entity_id),
        KEY idx_uesm_rank (user_id, bucket_year, bucket_month, entity_type, rank_in_bucket),
        KEY idx_uesm_user_entity (user_id, entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

    `CREATE TABLE IF NOT EXISTS user_entity_stats_yearly (
        user_id             CHAR(36) NOT NULL,
        bucket_year         SMALLINT UNSIGNED NOT NULL,
        entity_type         ENUM('track', 'album', 'artist', 'playlist') NOT NULL,
        entity_id           VARCHAR(64) NOT NULL,
        play_count          INT UNSIGNED NOT NULL DEFAULT 0,
        weighted_play_count DECIMAL(12,3) NOT NULL DEFAULT 0,
        total_duration_ms   BIGINT UNSIGNED NOT NULL DEFAULT 0,
        first_played_at     TIMESTAMP(3) NULL DEFAULT NULL,
        last_played_at      TIMESTAMP(3) NULL DEFAULT NULL,
        is_first_ever       TINYINT(1) NOT NULL DEFAULT 0,
        score               DOUBLE NOT NULL DEFAULT 0,
        rank_in_bucket      INT UNSIGNED NOT NULL DEFAULT 0,
        display_title       VARCHAR(255) NULL DEFAULT NULL,
        display_subtitle    VARCHAR(255) NULL DEFAULT NULL,
        display_cover       TEXT NULL DEFAULT NULL,
        PRIMARY KEY (user_id, bucket_year, entity_type, entity_id),
        KEY idx_uesy_rank (user_id, bucket_year, entity_type, rank_in_bucket),
        KEY idx_uesy_user_entity (user_id, entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

    // Hour-of-day histogram, bucketed per local day.
    //
    // A separate table rather than a query over play_events, because the privacy contract is that every
    // user-facing surface reads from aggregates only - that is what lets raw events be pruned later without
    // taking a chart down with them. `hour` is the hour in the *user's* local time, resolved at rollup, so
    // the chart doesn't shift when someone travels.
    `CREATE TABLE IF NOT EXISTS user_hour_stats_daily (
        user_id           CHAR(36) NOT NULL,
        bucket_date       DATE NOT NULL,
        hour              TINYINT UNSIGNED NOT NULL,
        play_count        INT UNSIGNED NOT NULL DEFAULT 0,
        total_duration_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, bucket_date, hour),
        KEY idx_uhsd_user_date (user_id, bucket_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

    // ---- the Replay Mix -----------------------------------------------------------------------------
    //
    // Deliberately NOT a row in `playlists`. That is what makes it unmodifiable by anyone, user or admin,
    // through the UI or the API: there is no playlist id for PATCH/DELETE /playlist/{pid}, /tracks, /order,
    // /members or /image to resolve, so every one of those routes 404s at its existing getPlaylistById()
    // check without a single new guard. Immutability by construction beats immutability by policy - a policy
    // check is something a future route can forget to add.
    //
    // bucket_year 0 is the All-Time mix. Past years are simply never rebuilt; the archive is whatever rows
    // are already sitting at that year.
    `CREATE TABLE IF NOT EXISTS user_replay_playlists (
        user_id           CHAR(36) NOT NULL,
        bucket_year       SMALLINT UNSIGNED NOT NULL,
        position          SMALLINT UNSIGNED NOT NULL,
        track_id          CHAR(36) NOT NULL,
        score             DOUBLE NOT NULL DEFAULT 0,
        play_count        INT UNSIGNED NOT NULL DEFAULT 0,
        total_duration_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
        display_title     VARCHAR(255) NULL DEFAULT NULL,
        display_subtitle  VARCHAR(255) NULL DEFAULT NULL,
        display_cover     TEXT NULL DEFAULT NULL,
        refreshed_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, bucket_year, position),
        KEY idx_urp_user_year (user_id, bucket_year)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

    // ---- year-end snapshot --------------------------------------------------------------------------
    //
    // Frozen in early December and never recomputed, so the year-end package a user shared in December still
    // says the same thing years later even after tracks leave their library. `payload` holds the whole
    // rendered summary; the scalar columns beside it are duplicated out so listing past years doesn't have
    // to parse JSON.
    //
    // reel_path is a bare filename, never a caller-supplied path - see insightsReel.ts.
    `CREATE TABLE IF NOT EXISTS user_year_snapshots (
        user_id             CHAR(36) NOT NULL,
        bucket_year         SMALLINT UNSIGNED NOT NULL,
        payload             JSON NOT NULL,
        total_minutes       INT UNSIGNED NOT NULL DEFAULT 0,
        unique_tracks       INT UNSIGNED NOT NULL DEFAULT 0,
        unique_albums       INT UNSIGNED NOT NULL DEFAULT 0,
        unique_artists      INT UNSIGNED NOT NULL DEFAULT 0,
        longest_streak_days INT UNSIGNED NOT NULL DEFAULT 0,
        reel_status         ENUM('none', 'queued', 'rendering', 'ready', 'failed') NOT NULL DEFAULT 'none',
        reel_path           VARCHAR(255) NULL DEFAULT NULL,
        reel_error          TEXT NULL DEFAULT NULL,
        created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (user_id, bucket_year),
        KEY idx_uys_reel_status (reel_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

    // ---- scheduler bookkeeping ----------------------------------------------------------------------
    //
    // Nafyn has no job queue (bullmq is a dependency but unused, and there is no Redis), so the scheduler is
    // an in-process interval. This table is what keeps that honest across restarts and replicas: a job is
    // claimed by an atomic INSERT ... ON DUPLICATE KEY UPDATE that only flips status to 'running' when the
    // row isn't already running or its heartbeat has gone stale. 'done' rows are never reclaimed (so a
    // restart can't double-run a period), and a crashed 'running' row becomes reclaimable once its heartbeat
    // ages out (so a crash can't skip one either).
    `CREATE TABLE IF NOT EXISTS insight_job_runs (
        job_name     VARCHAR(64) NOT NULL,
        period_key   VARCHAR(32) NOT NULL,
        status       ENUM('running', 'done', 'failed') NOT NULL DEFAULT 'running',
        locked_by    VARCHAR(64) NULL DEFAULT NULL,
        locked_at    TIMESTAMP(3) NULL DEFAULT NULL,
        heartbeat_at TIMESTAMP(3) NULL DEFAULT NULL,
        finished_at  TIMESTAMP(3) NULL DEFAULT NULL,
        attempts     INT UNSIGNED NOT NULL DEFAULT 0,
        error        TEXT NULL DEFAULT NULL,
        PRIMARY KEY (job_name, period_key),
        KEY idx_ijr_status (status, heartbeat_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`
];

export async function createInsightsTables(): Promise<void> {
    const conn = await getConnection();
    try {
        for (const statement of STATEMENTS) {
            await conn.query(statement);
        }
    } finally {
        conn.release();
    }
}
