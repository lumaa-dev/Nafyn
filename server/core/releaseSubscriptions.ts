// "notify me when this comes out" for unreleased albums and tracks.
//
// A subscription is stored with the subscriber's IANA timezone (sent by the browser/app when subscribing) and
// the UTC instant of local midnight on the release date in that zone (`releaseAt`). The scheduler
// (server/plugins/notificationJobs.ts) then needs nothing but a range scan on `releaseAt`:
//   * releaseAt - 3 h: the countdown Live Activity starts on the subscriber's Apple devices;
//   * releaseAt:       the "out now" notification goes out (APNs + the subscriber's own webhooks).
// Each step is claimed with a conditional UPDATE (`… WHERE notifiedAt IS NULL`), so with several replicas
// running the scheduler exactly one of them sends it.
//
// MusicBrainz dates move (an announced date slips, a partial "2027" becomes a full date), so unsent
// subscriptions are re-resolved once a day (refreshReleaseDates).
import { randomUUID } from "node:crypto";
import { getUsersDb, sqlInt } from "./db";
import { getMediaInfo } from "../utils/musicbrainz";
import { isReleased, localMidnightUtc, releaseDateFromDate } from "../utils/releaseDate";

// how long before release the countdown Live Activity starts
export const RELEASE_ACTIVITY_LEAD_MS = 3 * 60 * 60 * 1000;

interface SubscriptionRow {
    id: string,
    userId: string,
    musicbrainzId: string,
    type: "album" | "track",
    title: string | null,
    artistName: string | null,
    coverArt: string | null,
    releaseDate: string,
    timezone: string,
    releaseAt: number,
    activityStartedAt: number | null,
    notifiedAt: number | null,
    createdAt: number
}

export interface ReleaseSubscription {
    id: string,
    musicbrainzId: string,
    type: "album" | "track",
    title: string | null,
    artistName: string | null,
    coverArt: string | null,
    /** YYYY-MM-DD */
    releaseDate: string,
    timezone: string,
    /** epoch ms of local midnight on releaseDate in `timezone` */
    releaseAt: number,
    notifiedAt: number | null,
    createdAt: number
}

export class SubscriptionError extends Error {
    constructor(message: string, public statusCode: number = 400) {
        super(message);
    }
}

function rowToSubscription(row: SubscriptionRow): ReleaseSubscription {
    return {
        id: row.id,
        musicbrainzId: row.musicbrainzId,
        type: row.type,
        title: row.title,
        artistName: row.artistName,
        coverArt: row.coverArt,
        releaseDate: row.releaseDate,
        timezone: row.timezone,
        releaseAt: Number(row.releaseAt),
        notifiedAt: row.notifiedAt == null ? null : Number(row.notifiedAt),
        createdAt: Number(row.createdAt)
    };
}

/** Subscribes `userId` to an unreleased album/track. Re-subscribing just refreshes the timezone and date. */
export async function createSubscription(userId: string, musicbrainzId: string, type: "album" | "track", timezone: string): Promise<ReleaseSubscription> {
    const info = await getMediaInfo(musicbrainzId, type).catch(() => null);
    if (!info) throw new SubscriptionError("Nothing found on MusicBrainz for this ID", 404);

    const releaseDate = releaseDateFromDate(info.releaseDate);
    if (!releaseDate) throw new SubscriptionError("This has no announced release date", 409);
    if (isReleased(releaseDate)) throw new SubscriptionError("This is already released", 409);

    const artistName = typeof info.artist === "string" ? info.artist : info.artist.name;
    const row: SubscriptionRow = {
        id: randomUUID(),
        userId,
        musicbrainzId,
        type,
        title: info.title,
        artistName,
        coverArt: info.coverArt,
        releaseDate,
        timezone,
        releaseAt: localMidnightUtc(releaseDate, timezone),
        activityStartedAt: null,
        notifiedAt: null,
        createdAt: Date.now()
    };

    await getUsersDb().prepare(`
        INSERT INTO release_subscriptions (id, userId, musicbrainzId, type, title, artistName, coverArt, releaseDate, timezone, releaseAt, activityStartedAt, notifiedAt, createdAt)
        VALUES (:id, :userId, :musicbrainzId, :type, :title, :artistName, :coverArt, :releaseDate, :timezone, :releaseAt, :activityStartedAt, :notifiedAt, :createdAt)
        ON DUPLICATE KEY UPDATE title = VALUES(title), artistName = VALUES(artistName), coverArt = VALUES(coverArt),
            releaseDate = VALUES(releaseDate), timezone = VALUES(timezone), releaseAt = VALUES(releaseAt),
            activityStartedAt = NULL, notifiedAt = NULL
    `).run(row);

    const stored = await getUsersDb().prepare(
        `SELECT * FROM release_subscriptions WHERE userId = ? AND musicbrainzId = ?`
    ).get(userId, musicbrainzId) as SubscriptionRow;
    return rowToSubscription(stored);
}

export async function deleteSubscription(userId: string, musicbrainzId: string): Promise<boolean> {
    const result = await getUsersDb().prepare(
        `DELETE FROM release_subscriptions WHERE userId = ? AND musicbrainzId = ?`
    ).run(userId, musicbrainzId);
    return result.changes > 0;
}

export async function isSubscribed(userId: string, musicbrainzId: string): Promise<boolean> {
    const row = await getUsersDb().prepare(
        `SELECT 1 FROM release_subscriptions WHERE userId = ? AND musicbrainzId = ? AND notifiedAt IS NULL LIMIT 1`
    ).get(userId, musicbrainzId);
    return row != null;
}

export async function getSubscriptionById(id: string): Promise<(ReleaseSubscription & { userId: string }) | null> {
    const row = await getUsersDb().prepare(`SELECT * FROM release_subscriptions WHERE id = ?`).get(id) as SubscriptionRow | undefined;
    return row ? { ...rowToSubscription(row), userId: row.userId } : null;
}

/** upcoming first, then already-delivered ones */
export async function listSubscriptions(userId: string, limit: number, offset: number): Promise<ReleaseSubscription[]> {
    const rows = await getUsersDb().prepare(`
        SELECT * FROM release_subscriptions WHERE userId = ?
        ORDER BY notifiedAt IS NOT NULL, releaseAt ASC
        LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}
    `).all(userId) as SubscriptionRow[];
    return rows.map(rowToSubscription);
}

export async function countSubscriptions(userId: string): Promise<number> {
    const row = await getUsersDb().prepare(`SELECT COUNT(*) AS count FROM release_subscriptions WHERE userId = ?`).get(userId) as { count: number };
    return Number(row.count);
}

// erasure helper (GDPR art. 17)
export async function deleteReleaseSubscriptionsForUser(userId: string): Promise<number> {
    const result = await getUsersDb().prepare(`DELETE FROM release_subscriptions WHERE userId = ?`).run(userId);
    return result.changes;
}

// data-access export (GDPR art. 15)
export async function listSubscriptionExportForUser(userId: string): Promise<ReleaseSubscription[]> {
    const rows = await getUsersDb().prepare(
        `SELECT * FROM release_subscriptions WHERE userId = ? ORDER BY createdAt ASC`
    ).all(userId) as SubscriptionRow[];
    return rows.map(rowToSubscription);
}

// ---------------------------------------------------------------------------------------------------------
// scheduler side
// ---------------------------------------------------------------------------------------------------------

export type DueSubscription = ReleaseSubscription & { userId: string };

/** subscriptions entering their 3-hour countdown window that haven't had their Live Activity started */
export async function claimDueActivities(nowMs: number = Date.now()): Promise<DueSubscription[]> {
    const rows = await getUsersDb().prepare(`
        SELECT * FROM release_subscriptions
        WHERE notifiedAt IS NULL AND activityStartedAt IS NULL AND releaseAt > ? AND releaseAt <= ?
        LIMIT 200
    `).all(nowMs, nowMs + RELEASE_ACTIVITY_LEAD_MS) as SubscriptionRow[];

    const claimed: DueSubscription[] = [];
    for (const row of rows) {
        const result = await getUsersDb().prepare(
            `UPDATE release_subscriptions SET activityStartedAt = ? WHERE id = ? AND activityStartedAt IS NULL`
        ).run(nowMs, row.id);
        if (result.changes > 0) claimed.push({ ...rowToSubscription(row), userId: row.userId });
    }
    return claimed;
}

/** subscriptions whose release moment has passed and haven't been notified yet */
export async function claimDueReleases(nowMs: number = Date.now()): Promise<DueSubscription[]> {
    const rows = await getUsersDb().prepare(`
        SELECT * FROM release_subscriptions WHERE notifiedAt IS NULL AND releaseAt <= ? LIMIT 200
    `).all(nowMs) as SubscriptionRow[];

    const claimed: DueSubscription[] = [];
    for (const row of rows) {
        const result = await getUsersDb().prepare(
            `UPDATE release_subscriptions SET notifiedAt = ? WHERE id = ? AND notifiedAt IS NULL`
        ).run(nowMs, row.id);
        if (result.changes > 0) claimed.push({ ...rowToSubscription(row), userId: row.userId });
    }
    return claimed;
}

/**
 * Re-resolves release dates of pending subscriptions against MusicBrainz, one lookup per distinct MBID.
 * Capped per run: MusicBrainz allows about one request per second, and this is background housekeeping.
 */
export async function refreshReleaseDates(maxLookups: number = 50): Promise<number> {
    const db = getUsersDb();
    const pending = await db.prepare(`
        SELECT musicbrainzId, MIN(type) AS type FROM release_subscriptions
        WHERE notifiedAt IS NULL GROUP BY musicbrainzId ORDER BY MIN(releaseAt) ASC LIMIT ${sqlInt(maxLookups)}
    `).all() as { musicbrainzId: string, type: "album" | "track" }[];

    let changed = 0;
    for (const { musicbrainzId, type } of pending) {
        const info = await getMediaInfo(musicbrainzId, type).catch(() => null);
        const releaseDate = releaseDateFromDate(info?.releaseDate);
        if (!releaseDate) continue;

        const rows = await db.prepare(`
            SELECT id, timezone, releaseDate FROM release_subscriptions WHERE musicbrainzId = ? AND notifiedAt IS NULL
        `).all(musicbrainzId) as Pick<SubscriptionRow, "id" | "timezone" | "releaseDate">[];

        for (const row of rows) {
            if (row.releaseDate === releaseDate) continue;
            // a moved date gets a fresh countdown too
            await db.prepare(`
                UPDATE release_subscriptions SET releaseDate = ?, releaseAt = ?, activityStartedAt = NULL WHERE id = ? AND notifiedAt IS NULL
            `).run(releaseDate, localMidnightUtc(releaseDate, row.timezone), row.id);
            changed++;
        }
    }
    return changed;
}

/** retention: delivered subscriptions have done their job; keep them visible in settings for a while */
export async function pruneNotifiedSubscriptions(olderThanMs: number): Promise<number> {
    const result = await getUsersDb().prepare(
        `DELETE FROM release_subscriptions WHERE notifiedAt IS NOT NULL AND notifiedAt < ?`
    ).run(Date.now() - olderThanMs);
    return result.changes;
}
