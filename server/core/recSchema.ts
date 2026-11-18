// tables of the recommender (personalized mixes + the For You page's contextual bandit).
//
// All new tables, so CREATE TABLE IF NOT EXISTS is enough on existing installs too; a later change to one of
// them goes into migrations.ts like any other. Created with the same charset/collation as `media`
// (resolveTableOptions), because rec_mix_tracks.media_id and rec_audio_features join against media.id.
//
// Personal data, and therefore listed in eraseAccount() and buildAccountExport(): rec_user_settings,
// rec_user_state, rec_mixes (+ rec_mix_tracks through them), rec_decisions, rec_feedback. The rest is not
// about anybody: audio features of files and recordings, cached public catalogue answers, and the aggregate
// bandit models.
import { getConnection } from "./db";
import { resolveTableOptions } from "./insightsSchema";

function statements(tableOptions: string): string[] {
    return [
        // opt-out: no row = personalization on (the default); a row with enabled = 0 = off
        `CREATE TABLE IF NOT EXISTS rec_user_settings (
            user_id    CHAR(36) NOT NULL,
            enabled    TINYINT(1) NOT NULL DEFAULT 1,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (user_id)
        ) ${tableOptions}`,

        // mix refresh bookkeeping, and the user's collaborative-filtering embedding (the bandit's context)
        `CREATE TABLE IF NOT EXISTS rec_user_state (
            user_id           CHAR(36) NOT NULL,
            last_refresh_at   BIGINT NULL DEFAULT NULL,
            signals_at_refresh INT UNSIGNED NOT NULL DEFAULT 0,
            status            ENUM('idle', 'running', 'failed') NOT NULL DEFAULT 'idle',
            heartbeat_at      BIGINT NULL DEFAULT NULL,
            error             TEXT NULL DEFAULT NULL,
            embedding         TEXT NULL DEFAULT NULL,
            top_artists       JSON NULL DEFAULT NULL,
            PRIMARY KEY (user_id),
            KEY idx_rus_status (status, last_refresh_at)
        ) ${tableOptions}`,

        // one row per mix. `centroid` (base64 Float64Array) is how the next refresh recognizes the same mix
        `CREATE TABLE IF NOT EXISTS rec_mixes (
            id           CHAR(36) NOT NULL,
            user_id      CHAR(36) NOT NULL,
            position     SMALLINT UNSIGNED NOT NULL,
            label        JSON NOT NULL,
            title        VARCHAR(255) NOT NULL,
            share        DOUBLE NOT NULL DEFAULT 0,
            centroid     MEDIUMTEXT NOT NULL,
            top_artists  JSON NOT NULL,
            created_at   BIGINT NOT NULL,
            refreshed_at BIGINT NOT NULL,
            PRIMARY KEY (id),
            KEY idx_rec_mixes_user (user_id, position)
        ) ${tableOptions}`,

        // a mix's tracks. Familiar ones point at the shared media row; suggestions are catalogue recordings,
        // so their display fields are a snapshot (the cover is the Cover Art Archive URL, rewritten on the way out)
        `CREATE TABLE IF NOT EXISTS rec_mix_tracks (
            mix_id       CHAR(36) NOT NULL,
            position     SMALLINT UNSIGNED NOT NULL,
            track_key    VARCHAR(64) NOT NULL,
            media_id     VARCHAR(36) NULL DEFAULT NULL,
            recording_id VARCHAR(36) NULL DEFAULT NULL,
            familiar     TINYINT(1) NOT NULL,
            confidence   DOUBLE NOT NULL DEFAULT 0,
            reason       JSON NOT NULL,
            title        VARCHAR(512) NOT NULL,
            artist       VARCHAR(512) NOT NULL,
            album        VARCHAR(512) NULL DEFAULT NULL,
            album_id     VARCHAR(64) NULL DEFAULT NULL,
            cover_art    TEXT NULL DEFAULT NULL,
            duration_ms  INT UNSIGNED NULL DEFAULT NULL,
            released_at  BIGINT NULL DEFAULT NULL,
            PRIMARY KEY (mix_id, position),
            KEY idx_rmt_media (media_id),
            KEY idx_rmt_recording (recording_id)
        ) ${tableOptions}`,

        // measured audio descriptors. subject = "media:<id>" (a file Nafyn holds) or "rec:<recording MBID>" (a
        // preview). status 'none' = nothing analysable (no preview, silence): not retried for a while
        `CREATE TABLE IF NOT EXISTS rec_audio_features (
            subject     VARCHAR(64) NOT NULL,
            features    JSON NULL DEFAULT NULL,
            status      ENUM('ok', 'none', 'failed') NOT NULL,
            analyzed_at BIGINT NOT NULL,
            PRIMARY KEY (subject),
            KEY idx_raf_status (status, analyzed_at)
        ) ${tableOptions}`,

        // answers of public catalogue services (ListenBrainz similarity, MusicBrainz genres), keyed by request
        `CREATE TABLE IF NOT EXISTS rec_external_cache (
            cache_key  VARCHAR(191) NOT NULL,
            payload    MEDIUMTEXT NOT NULL,
            fetched_at BIGINT NOT NULL,
            PRIMARY KEY (cache_key),
            KEY idx_rec_cache_fetched (fetched_at)
        ) ${tableOptions}`,

        // every ranking decision of the For You page, with everything offline evaluation needs: the context,
        // each candidate's action vector (base64 Float64Array, action_dim per candidate), the order shown, the
        // conditional propensity of each position, and - once the attribution window closes - its reward
        `CREATE TABLE IF NOT EXISTS rec_decisions (
            id             CHAR(36) NOT NULL,
            page_id        CHAR(36) NOT NULL,
            user_id        CHAR(36) NOT NULL,
            level          ENUM('shelf', 'card') NOT NULL,
            shelf_kind     VARCHAR(16) NULL DEFAULT NULL,
            policy         VARCHAR(16) NOT NULL,
            policy_version INT UNSIGNED NOT NULL,
            context        TEXT NOT NULL,
            actions        MEDIUMTEXT NOT NULL,
            action_dim     SMALLINT UNSIGNED NOT NULL,
            action_ids     JSON NOT NULL,
            item_keys      JSON NOT NULL,
            chosen         JSON NOT NULL,
            propensities   JSON NOT NULL,
            scores         JSON NOT NULL,
            rewards        JSON NULL DEFAULT NULL,
            confidences    JSON NULL DEFAULT NULL,
            created_at     BIGINT NOT NULL,
            finalized_at   BIGINT NULL DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_rd_user (user_id, created_at),
            KEY idx_rd_page (page_id),
            KEY idx_rd_pending (finalized_at, created_at)
        ) ${tableOptions}`,

        // what the person did with a card, inside the attribution window
        `CREATE TABLE IF NOT EXISTS rec_feedback (
            id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            decision_id CHAR(36) NOT NULL,
            user_id     CHAR(36) NOT NULL,
            slot        SMALLINT UNSIGNED NOT NULL,
            event       VARCHAR(12) NOT NULL,
            ms_played   INT UNSIGNED NOT NULL DEFAULT 0,
            created_at  BIGINT NOT NULL,
            PRIMARY KEY (id),
            KEY idx_rf_decision (decision_id),
            KEY idx_rf_user (user_id)
        ) ${tableOptions}`,

        // bandit models: the serving one per level ('active'), and every candidate the offline gate looked at
        `CREATE TABLE IF NOT EXISTS rec_models (
            id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
            level      ENUM('shelf', 'card') NOT NULL,
            kind       VARCHAR(16) NOT NULL,
            status     ENUM('active', 'candidate', 'retired', 'rejected') NOT NULL,
            state      LONGTEXT NOT NULL,
            served     BIGINT UNSIGNED NOT NULL DEFAULT 0,
            metrics    JSON NULL DEFAULT NULL,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (id),
            KEY idx_rec_models_level (level, status)
        ) ${tableOptions}`
    ];
}

export async function createRecommendationTables(): Promise<void> {
    const conn = await getConnection();
    try {
        const tableOptions = await resolveTableOptions(conn);
        for (const statement of statements(tableOptions)) {
            await conn.query(statement);
        }
    } finally {
        conn.release();
    }
}
