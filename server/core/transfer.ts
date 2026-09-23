// persistence for library imports (Settings -> Import): jobs, the items found in the source library, and
// the source playlists they belong to. The processing itself lives in transferWorker.ts.
import { randomUUID } from "node:crypto";
import { getRequestsDb, sqlInt } from "./db";
import type {
    TransferFailReason,
    TransferItem,
    TransferItemKind,
    TransferItemSource,
    TransferItemStatus,
    TransferJob,
    TransferJobStatus,
    TransferSourceId
} from "../entity/Transfer";

export interface TransferJobRow {
    id: string,
    userId: string,
    provider: TransferSourceId,
    status: TransferJobStatus,
    error: string | null,
    totalItems: number,
    truncated: number,
    createdAt: number,
    updatedAt: number,
    finishedAt: number | null
}

export interface TransferItemRow {
    id: string,
    jobId: string,
    position: number,
    kind: TransferItemKind,
    source: TransferItemSource,
    playlistRef: string | null,
    externalId: string | null,
    title: string | null,
    artistName: string | null,
    albumName: string | null,
    isrc: string | null,
    upc: string | null,
    durationMs: number | null,
    status: TransferItemStatus,
    failReason: TransferFailReason | null,
    alreadyOwned: number,
    musicbrainzId: string | null,
    matchedBy: "isrc" | "upc" | "search" | null,
    requestId: string | null,
    updatedAt: number
}

export interface TransferPlaylistRow {
    id: string,
    jobId: string,
    externalId: string | null,
    title: string,
    description: string | null,
    nafynPlaylistId: string | null
}

export type NewTransferItem = Pick<TransferItemRow, "kind" | "source" | "playlistRef" | "externalId" | "title" | "artistName" | "albumName" | "isrc" | "upc" | "durationMs">
    & { unsupported?: boolean };

const ACTIVE_STATUSES: TransferJobStatus[] = ["fetching", "matching", "downloading"];

// column widths from transferSchema.ts; upstream data is clipped rather than failing the insert
function clip(value: string | null | undefined, max: number): string | null {
    if (value === null || value === undefined) return null;
    return value.length > max ? value.slice(0, max) : value;
}

export async function createTransferJob(userId: string, provider: TransferSourceId, status: TransferJobStatus = "fetching"): Promise<TransferJobRow> {
    const now = Date.now();
    const row: TransferJobRow = { id: randomUUID(), userId, provider, status, error: null, totalItems: 0, truncated: 0, createdAt: now, updatedAt: now, finishedAt: null };
    await getRequestsDb().prepare(`
        INSERT INTO transfer_jobs (id, userId, provider, status, error, totalItems, truncated, createdAt, updatedAt, finishedAt)
        VALUES (:id, :userId, :provider, :status, :error, :totalItems, :truncated, :createdAt, :updatedAt, :finishedAt)
    `).run(row);
    return row;
}

export async function getTransferJobRow(id: string): Promise<TransferJobRow | null> {
    return (await getRequestsDb().prepare(`SELECT * FROM transfer_jobs WHERE id = ?`).get(id) as TransferJobRow | undefined) ?? null;
}

export async function hasActiveTransferJob(userId: string): Promise<boolean> {
    const row = await getRequestsDb().prepare(`
        SELECT 1 FROM transfer_jobs WHERE userId = ? AND status IN ('fetching', 'matching', 'downloading') LIMIT 1
    `).get(userId);
    return row != null;
}

export async function setTransferJobStatus(id: string, status: TransferJobStatus, error: string | null = null): Promise<void> {
    const now = Date.now();
    const finished = !ACTIVE_STATUSES.includes(status);
    await getRequestsDb().prepare(`
        UPDATE transfer_jobs SET status = ?, error = COALESCE(?, error), updatedAt = ?, finishedAt = ? WHERE id = ?
    `).run(status, clip(error, 1000), now, finished ? now : null, id);
}

// conditional transition, so two workers (or a worker and a cancel) can't both move the same job
export async function transitionTransferJob(id: string, from: TransferJobStatus, to: TransferJobStatus): Promise<boolean> {
    const now = Date.now();
    const finished = !ACTIVE_STATUSES.includes(to);
    const result = await getRequestsDb().prepare(`
        UPDATE transfer_jobs SET status = ?, updatedAt = ?, finishedAt = ? WHERE id = ? AND status = ?
    `).run(to, now, finished ? now : null, id, from);
    return result.changes > 0;
}

export async function touchTransferJob(id: string): Promise<void> {
    await getRequestsDb().prepare(`UPDATE transfer_jobs SET updatedAt = ? WHERE id = ?`).run(Date.now(), id);
}

export async function createTransferPlaylist(jobId: string, externalId: string | null, title: string, description: string | null): Promise<TransferPlaylistRow> {
    const row: TransferPlaylistRow = { id: randomUUID(), jobId, externalId: clip(externalId, 255), title: clip(title, 500) ?? "Imported playlist", description: clip(description, 2000), nafynPlaylistId: null };
    await getRequestsDb().prepare(`
        INSERT INTO transfer_playlists (id, jobId, externalId, title, description, nafynPlaylistId)
        VALUES (:id, :jobId, :externalId, :title, :description, :nafynPlaylistId)
    `).run(row);
    return row;
}

export async function getTransferPlaylist(id: string): Promise<TransferPlaylistRow | null> {
    return (await getRequestsDb().prepare(`SELECT * FROM transfer_playlists WHERE id = ?`).get(id) as TransferPlaylistRow | undefined) ?? null;
}

export async function setTransferPlaylistTarget(id: string, nafynPlaylistId: string): Promise<void> {
    await getRequestsDb().prepare(`UPDATE transfer_playlists SET nafynPlaylistId = ? WHERE id = ?`).run(nafynPlaylistId, id);
}

// appends items after the job's current last position, in chunks of multi-row INSERTs
export async function insertTransferItems(jobId: string, items: NewTransferItem[]): Promise<void> {
    if (items.length === 0) return;
    const db = getRequestsDb();
    const { max } = await db.prepare(`SELECT MAX(position) AS max FROM transfer_items WHERE jobId = ?`).get(jobId) as { max: number | null };
    let position = (max ?? -1) + 1;
    const now = Date.now();

    const COLUMNS = 16;
    for (let i = 0; i < items.length; i += 200) {
        const batch = items.slice(i, i + 200);
        const params: unknown[] = [];
        for (const item of batch) {
            const failed = item.unsupported ? "failed" : "pending";
            params.push(
                randomUUID(), jobId, position++, item.kind, item.source, item.playlistRef,
                clip(item.externalId, 255), clip(item.title, 1000), clip(item.artistName, 1000), clip(item.albumName, 1000),
                clip(item.isrc, 16), clip(item.upc, 20), item.durationMs !== null && Number.isFinite(item.durationMs) ? Math.round(item.durationMs) : null,
                failed, item.unsupported ? "unsupported" : null, now
            );
        }
        const placeholders = batch.map(() => `(${new Array(COLUMNS).fill("?").join(", ")})`).join(", ");
        await db.prepare(`
            INSERT INTO transfer_items (id, jobId, position, kind, source, playlistRef, externalId, title, artistName, albumName, isrc, upc, durationMs, status, failReason, updatedAt)
            VALUES ${placeholders}
        `).run(...params);
    }

    await db.prepare(`UPDATE transfer_jobs SET totalItems = (SELECT COUNT(*) FROM transfer_items WHERE jobId = ?), updatedAt = ? WHERE id = ?`).run(jobId, now, jobId);
}

export async function markTransferJobTruncated(id: string): Promise<void> {
    await getRequestsDb().prepare(`UPDATE transfer_jobs SET truncated = 1 WHERE id = ?`).run(id);
}

// -- worker claims --

// the next item waiting for MusicBrainz matching, oldest job first, in source order
export async function nextItemToMatch(): Promise<TransferItemRow | null> {
    const row = await getRequestsDb().prepare(`
        SELECT i.* FROM transfer_items i
        JOIN transfer_jobs j ON j.id = i.jobId
        WHERE i.status = 'pending' AND j.status = 'matching'
        ORDER BY j.createdAt ASC, i.position ASC
        LIMIT 1
    `).get() as TransferItemRow | undefined;
    return row ?? null;
}

// the next matched item to download, strictly in source order within a job - that's what keeps an
// imported playlist's track order intact, since entries are appended as each download lands
export async function nextItemToDownload(): Promise<TransferItemRow | null> {
    const row = await getRequestsDb().prepare(`
        SELECT i.* FROM transfer_items i
        JOIN transfer_jobs j ON j.id = i.jobId
        WHERE i.status = 'matched' AND j.status = 'downloading'
        ORDER BY j.createdAt ASC, i.position ASC
        LIMIT 1
    `).get() as TransferItemRow | undefined;
    return row ?? null;
}

export async function claimTransferItem(id: string, from: TransferItemStatus, to: TransferItemStatus): Promise<boolean> {
    const result = await getRequestsDb().prepare(`
        UPDATE transfer_items SET status = ?, updatedAt = ? WHERE id = ? AND status = ?
    `).run(to, Date.now(), id, from);
    return result.changes > 0;
}

export async function updateTransferItem(id: string, patch: Partial<Pick<TransferItemRow, "status" | "failReason" | "musicbrainzId" | "matchedBy" | "requestId" | "alreadyOwned">>): Promise<void> {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    // keys come from the typed patch object above, never from a request - safe to interpolate as identifiers
    const sets = keys.map((k) => `${k} = :${k}`).join(", ");
    await getRequestsDb().prepare(`UPDATE transfer_items SET ${sets}, updatedAt = :updatedAt WHERE id = :id`).run({ ...patch, updatedAt: Date.now(), id });
}

export async function countTransferItemsWithStatus(jobId: string, statuses: TransferItemStatus[]): Promise<number> {
    const placeholders = statuses.map(() => "?").join(", ");
    const row = await getRequestsDb().prepare(`SELECT COUNT(*) AS count FROM transfer_items WHERE jobId = ? AND status IN (${placeholders})`).get(jobId, ...statuses) as { count: number };
    return Number(row.count);
}

export async function listTransferJobIdsWithStatus(status: TransferJobStatus): Promise<string[]> {
    const rows = await getRequestsDb().prepare(`SELECT id FROM transfer_jobs WHERE status = ?`).all(status) as { id: string }[];
    return rows.map((r) => r.id);
}

export async function listTransferItemsWithStatus(status: TransferItemStatus): Promise<TransferItemRow[]> {
    return await getRequestsDb().prepare(`SELECT * FROM transfer_items WHERE status = ?`).all(status) as TransferItemRow[];
}

export async function cancelTransferJobItems(jobId: string): Promise<void> {
    await getRequestsDb().prepare(`
        UPDATE transfer_items SET status = 'skipped', updatedAt = ? WHERE jobId = ? AND status IN ('pending', 'matched')
    `).run(Date.now(), jobId);
}

// puts failed downloads back in the queue; matching failures stay failed (retrying them gives the same answer)
export async function retryFailedTransferDownloads(jobId: string): Promise<number> {
    const result = await getRequestsDb().prepare(`
        UPDATE transfer_items SET status = 'matched', failReason = NULL, requestId = NULL, updatedAt = ?
        WHERE jobId = ? AND status = 'failed' AND failReason = 'download_failed'
    `).run(Date.now(), jobId);
    return result.changes;
}

export async function deleteTransferJob(id: string): Promise<void> {
    // items/playlists go with it through ON DELETE CASCADE
    await getRequestsDb().prepare(`DELETE FROM transfer_jobs WHERE id = ?`).run(id);
}

// -- API views --

async function toJob(row: TransferJobRow): Promise<TransferJob> {
    const db = getRequestsDb();
    const statusRows = await db.prepare(`SELECT status, COUNT(*) AS count FROM transfer_items WHERE jobId = ? GROUP BY status`).all(row.id) as { status: TransferItemStatus, count: number }[];
    const failRows = await db.prepare(`SELECT failReason, COUNT(*) AS count FROM transfer_items WHERE jobId = ? AND status = 'failed' GROUP BY failReason`).all(row.id) as { failReason: TransferFailReason | null, count: number }[];
    const kindRows = await db.prepare(`SELECT kind, COUNT(*) AS count FROM transfer_items WHERE jobId = ? GROUP BY kind`).all(row.id) as { kind: TransferItemKind, count: number }[];
    const owned = await db.prepare(`SELECT COUNT(*) AS count FROM transfer_items WHERE jobId = ? AND alreadyOwned = 1`).get(row.id) as { count: number };

    const counts = { pending: 0, matched: 0, requested: 0, completed: 0, failed: 0, skipped: 0 };
    for (const { status, count } of statusRows) {
        // "matching" is a momentary claim state; to a reader it's still pending
        const key = status === "matching" ? "pending" : status;
        counts[key] += Number(count);
    }

    const failures: TransferJob["failures"] = {};
    for (const { failReason, count } of failRows) failures[failReason ?? "not_found"] = (failures[failReason ?? "not_found"] ?? 0) + Number(count);

    const kinds = { track: 0, album: 0, artist: 0 };
    for (const { kind, count } of kindRows) kinds[kind] = Number(count);

    return {
        id: row.id,
        provider: row.provider,
        status: row.status,
        error: row.error,
        totalItems: Number(row.totalItems),
        truncated: !!row.truncated,
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt),
        finishedAt: row.finishedAt !== null ? Number(row.finishedAt) : null,
        counts,
        alreadyOwned: Number(owned.count),
        failures,
        kinds
    };
}

export async function getTransferJob(id: string): Promise<TransferJob | null> {
    const row = await getTransferJobRow(id);
    return row ? toJob(row) : null;
}

export async function listTransferJobs(userId: string, limit: number, offset: number): Promise<TransferJob[]> {
    const rows = await getRequestsDb().prepare(`
        SELECT * FROM transfer_jobs WHERE userId = ? ORDER BY createdAt DESC, id ASC LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}
    `).all(userId) as TransferJobRow[];
    return Promise.all(rows.map(toJob));
}

export async function countTransferJobs(userId: string): Promise<number> {
    const row = await getRequestsDb().prepare(`SELECT COUNT(*) AS count FROM transfer_jobs WHERE userId = ?`).get(userId) as { count: number };
    return Number(row.count);
}

export type TransferItemFilter = "all" | "failed" | "completed" | "remaining";

function filterClause(filter: TransferItemFilter): string {
    switch (filter) {
        case "failed": return `AND i.status = 'failed'`;
        case "completed": return `AND i.status = 'completed'`;
        case "remaining": return `AND i.status IN ('pending', 'matching', 'matched', 'requested')`;
        default: return "";
    }
}

export async function listTransferItems(jobId: string, filter: TransferItemFilter, limit: number, offset: number): Promise<TransferItem[]> {
    const rows = await getRequestsDb().prepare(`
        SELECT i.*, p.title AS playlistTitle FROM transfer_items i
        LEFT JOIN transfer_playlists p ON p.id = i.playlistRef
        WHERE i.jobId = ? ${filterClause(filter)}
        ORDER BY i.position ASC
        LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}
    `).all(jobId) as (TransferItemRow & { playlistTitle: string | null })[];

    return rows.map((r) => ({
        id: r.id,
        position: Number(r.position),
        kind: r.kind,
        source: r.source,
        title: r.title,
        artistName: r.artistName,
        albumName: r.albumName,
        isrc: r.isrc,
        upc: r.upc,
        status: r.status === "matching" ? "pending" : r.status,
        failReason: r.failReason,
        alreadyOwned: !!r.alreadyOwned,
        musicbrainzId: r.musicbrainzId,
        matchedBy: r.matchedBy,
        playlistTitle: r.playlistTitle
    }));
}

export async function countTransferItems(jobId: string, filter: TransferItemFilter): Promise<number> {
    const row = await getRequestsDb().prepare(`SELECT COUNT(*) AS count FROM transfer_items i WHERE i.jobId = ? ${filterClause(filter)}`).get(jobId) as { count: number };
    return Number(row.count);
}
