// Playlist imports: a list of tracks another service (Apple Music, ...) described, resolved to MusicBrainz and
// requested one by one in the background (POST /api/v1/import). The client hands over the whole list once and
// polls; the server paces itself - MusicBrainz through the bulk lane, requests through the same checks as
// POST /api/v1/request - so nothing is lost to a client-side timeout, a rate limit or a dismissed screen.
//
// One worker per import, in-process (like the download queue); `resumeImports()` picks up imports a restart
// interrupted. Personal data: both tables are in eraseAccount() and buildAccountExport(), finished imports are
// pruned after IMPORT_RETENTION_DAYS.
import { randomUUID } from "node:crypto";
import { getRequestsDb, sqlInt, withTransaction } from "./db";
import { createMediaRequest } from "./requestCreate";
import { resolveDescribedTrack, usableIsrc } from "./trackResolve";
import { MusicBrainzError, withMusicBrainzContext } from "../utils/musicbrainzRepository";

export const MAX_IMPORT_TRACKS = 1000;
export const IMPORT_RETENTION_DAYS = 30;

// an item MusicBrainz couldn't be asked about is retried this many times, a little later each time, before it is
// given up as an error - never reported as "not found"
const MAX_UPSTREAM_ATTEMPTS = 3;
const UPSTREAM_RETRY_BASE_MS = 30_000;

export type ImportStatus = "running" | "completed";
export type ImportItemStatus = "pending" | "requested" | "owned" | "already-requested" | "not-found" | "unreleased" | "error";
export const IMPORT_ITEM_STATUSES: ImportItemStatus[] = ["pending", "requested", "owned", "already-requested", "not-found", "unreleased", "error"];

export interface ImportTrackInput {
    isrc?: string | null,
    title: string,
    artist: string,
    album?: string | null,
    // seconds
    duration?: number | null
}

export interface ImportItem {
    position: number,
    isrc: string | null,
    title: string,
    artist: string,
    album: string | null,
    duration: number | null,
    status: ImportItemStatus,
    musicbrainzId: string | null,
    requestId: string | null,
    // how the recording was found: by ISRC or by searching title + artist
    via: "isrc" | "search" | null,
    message: string | null
}

export interface ImportJob {
    id: string,
    source: string | null,
    name: string | null,
    status: ImportStatus,
    total: number,
    processed: number,
    counts: Record<ImportItemStatus, number>,
    createdAt: number,
    updatedAt: number
}

interface ImportRow {
    id: string,
    userId: string,
    source: string | null,
    name: string | null,
    status: ImportStatus,
    total: number | string,
    processed: number | string,
    createdAt: number | string,
    updatedAt: number | string
}

interface ItemRow {
    position: number | string,
    isrc: string | null,
    title: string,
    artist: string,
    album: string | null,
    duration: number | string | null,
    status: ImportItemStatus,
    attempts: number | string,
    musicbrainzId: string | null,
    requestId: string | null,
    via: "isrc" | "search" | null,
    message: string | null
}

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function emptyCounts(): Record<ImportItemStatus, number> {
    return Object.fromEntries(IMPORT_ITEM_STATUSES.map((status) => [status, 0])) as Record<ImportItemStatus, number>;
}

function rowToItem(row: ItemRow): ImportItem {
    return {
        position: Number(row.position),
        isrc: row.isrc,
        title: row.title,
        artist: row.artist,
        album: row.album,
        duration: row.duration === null ? null : Number(row.duration),
        status: row.status,
        musicbrainzId: row.musicbrainzId,
        requestId: row.requestId,
        via: row.via,
        message: row.message
    };
}

async function countsFor(importIds: string[]): Promise<Map<string, Record<ImportItemStatus, number>>> {
    const counts = new Map<string, Record<ImportItemStatus, number>>();
    if (importIds.length === 0) return counts;
    const rows = await getRequestsDb().prepare(`
        SELECT importId, status, COUNT(*) AS count FROM import_items
        WHERE importId IN (${importIds.map(() => "?").join(", ")})
        GROUP BY importId, status
    `).all<{ importId: string, status: ImportItemStatus, count: number | string }>(...importIds);
    for (const row of rows) {
        const entry = counts.get(row.importId) ?? emptyCounts();
        if (row.status in entry) entry[row.status] = Number(row.count);
        counts.set(row.importId, entry);
    }
    return counts;
}

function rowToJob(row: ImportRow, counts: Record<ImportItemStatus, number> | undefined): ImportJob {
    return {
        id: row.id,
        source: row.source,
        name: row.name,
        status: row.status,
        total: Number(row.total),
        processed: Number(row.processed),
        counts: counts ?? emptyCounts(),
        createdAt: Number(row.createdAt),
        updatedAt: Number(row.updatedAt)
    };
}

// ---------------------------------------------------------------- reading

export async function hasRunningImport(userId: string): Promise<boolean> {
    const row = await getRequestsDb().prepare(`SELECT 1 FROM imports WHERE userId = ? AND status = 'running' LIMIT 1`).get(userId);
    return row != null;
}

/** One of the caller's imports with every item, or null (another user's import is null too). */
export async function getImport(id: string, userId: string): Promise<(ImportJob & { items: ImportItem[] }) | null> {
    const row = await getRequestsDb().prepare(`SELECT * FROM imports WHERE id = ? AND userId = ?`).get<ImportRow>(id, userId);
    if (!row) return null;
    const items = await getRequestsDb().prepare(`SELECT * FROM import_items WHERE importId = ? ORDER BY position`).all<ItemRow>(id);
    const counts = await countsFor([id]);
    return { ...rowToJob(row, counts.get(id)), items: items.map(rowToItem) };
}

/** The caller's imports, newest first, without their items. */
export async function listImports(userId: string, limit: number, offset: number): Promise<{ items: ImportJob[], total: number }> {
    const rows = await getRequestsDb().prepare(`
        SELECT * FROM imports WHERE userId = ? ORDER BY createdAt DESC, id
        LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset)}
    `).all<ImportRow>(userId);
    const total = await getRequestsDb().prepare(`SELECT COUNT(*) AS count FROM imports WHERE userId = ?`).get<{ count: number | string }>(userId);
    const counts = await countsFor(rows.map((row) => row.id));
    return { items: rows.map((row) => rowToJob(row, counts.get(row.id))), total: Number(total?.count ?? 0) };
}

// ---------------------------------------------------------------- creating

export async function createImport(userId: string, input: { source: string | null, name: string | null, tracks: ImportTrackInput[] }): Promise<ImportJob> {
    const id = randomUUID();
    const createdAt = now();

    await withTransaction(async (conn) => {
        await conn.execute(
            `INSERT INTO imports (id, userId, source, name, status, total, processed, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'running', ?, 0, ?, ?)`,
            [id, userId, input.source, input.name, input.tracks.length, createdAt, createdAt]
        );
        // in chunks: one multi-row INSERT per 200 items keeps a 1000-track import to a handful of round trips
        for (let start = 0; start < input.tracks.length; start += 200) {
            const chunk = input.tracks.slice(start, start + 200);
            const values: Array<string | number | null> = [];
            for (const [offset, track] of chunk.entries()) {
                values.push(id, start + offset, usableIsrc(track.isrc), track.title, track.artist, track.album ?? null, track.duration ?? null);
            }
            await conn.execute(
                `INSERT INTO import_items (importId, position, isrc, title, artist, album, duration, status) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, 'pending')").join(", ")}`,
                values
            );
        }
    });

    startImportWorker(id);
    const counts = emptyCounts();
    counts.pending = input.tracks.length;
    return { id, source: input.source, name: input.name, status: "running", total: input.tracks.length, processed: 0, counts, createdAt, updatedAt: createdAt };
}

// ---------------------------------------------------------------- the worker

const workers = new Set<string>();

/** Starts the background worker for an import, unless this process already runs one for it. Never throws. */
export function startImportWorker(id: string): void {
    if (workers.has(id)) return;
    workers.add(id);
    void runImport(id)
        .catch((error) => console.error(`[imports] import ${id} stopped:`, error))
        .finally(() => workers.delete(id));
}

/** Picks up every import a restart interrupted. */
export async function resumeImports(): Promise<void> {
    const rows = await getRequestsDb().prepare(`SELECT id FROM imports WHERE status = 'running'`).all<{ id: string }>();
    for (const row of rows) startImportWorker(row.id);
    if (rows.length > 0) console.log(`[imports] resumed ${rows.length} import(s)`);
}

async function finishItem(importId: string, position: number, fields: Partial<Pick<ItemRow, "status" | "musicbrainzId" | "requestId" | "via" | "message">>): Promise<void> {
    await getRequestsDb().prepare(`
        UPDATE import_items SET status = ?, musicbrainzId = ?, requestId = ?, via = ?, message = ? WHERE importId = ? AND position = ?
    `).run(fields.status ?? "error", fields.musicbrainzId ?? null, fields.requestId ?? null, fields.via ?? null, fields.message?.slice(0, 255) ?? null, importId, position);
    await getRequestsDb().prepare(`
        UPDATE imports SET processed = (SELECT COUNT(*) FROM import_items WHERE importId = ? AND status <> 'pending'), updatedAt = ? WHERE id = ?
    `).run(importId, now(), importId);
}

async function runImport(id: string): Promise<void> {
    const job = await getRequestsDb().prepare(`SELECT * FROM imports WHERE id = ?`).get<ImportRow>(id);
    if (!job || job.status !== "running") return;
    const userId = job.userId;

    // background work: its MusicBrainz calls queue behind anyone browsing and take turns with other users' work
    await withMusicBrainzContext({ lane: "bulk", key: userId }, async () => {
        for (;;) {
            // re-read every time: the account may have been erased (and the import with it) in the meantime
            const item = await getRequestsDb().prepare(`
                SELECT * FROM import_items WHERE importId = ? AND status = 'pending' ORDER BY position LIMIT 1
            `).get<ItemRow>(id);
            if (!item) break;
            await processItem(id, userId, item);
        }
    });

    await getRequestsDb().prepare(`UPDATE imports SET status = 'completed', updatedAt = ? WHERE id = ? AND status = 'running'`).run(now(), id);
    const counts = (await countsFor([id])).get(id);
    if (counts) console.log(`[imports] import ${id} done: ${IMPORT_ITEM_STATUSES.filter((status) => counts[status] > 0).map((status) => `${counts[status]} ${status}`).join(", ")}`);
}

// MusicBrainz couldn't be asked: retried later, an error only after MAX_UPSTREAM_ATTEMPTS
async function upstreamFailure(importId: string, item: ItemRow, message: string): Promise<void> {
    const attempts = Number(item.attempts) + 1;
    if (attempts >= MAX_UPSTREAM_ATTEMPTS) {
        await finishItem(importId, Number(item.position), { status: "error", message });
        return;
    }
    await getRequestsDb().prepare(`UPDATE import_items SET attempts = ? WHERE importId = ? AND position = ?`).run(attempts, importId, Number(item.position));
    console.log(`[imports] "${item.title}" - ${message}, retrying (${attempts}/${MAX_UPSTREAM_ATTEMPTS})`);
    await sleep(UPSTREAM_RETRY_BASE_MS * attempts);
}

async function processItem(importId: string, userId: string, item: ItemRow): Promise<void> {
    const position = Number(item.position);

    let resolved;
    try {
        resolved = await resolveDescribedTrack({
            isrc: item.isrc,
            title: item.title,
            artist: item.artist,
            duration: item.duration === null ? undefined : Number(item.duration)
        });
    } catch (error) {
        if (error instanceof MusicBrainzError) return upstreamFailure(importId, item, "MusicBrainz is unavailable");
        console.error(`[imports] resolving "${item.title}" failed:`, error);
        return finishItem(importId, position, { status: "error", message: "Could not look this track up" });
    }
    if (!resolved) return finishItem(importId, position, { status: "not-found", message: "No matching recording on MusicBrainz" });

    const result = await createMediaRequest(userId, resolved.recordingId, "track");
    const found = { musicbrainzId: resolved.recordingId, via: resolved.via };
    if (result.ok) return finishItem(importId, position, { status: "requested", requestId: result.request.id, ...found });

    switch (result.reason) {
        case "owned":
            return finishItem(importId, position, { status: "owned", ...found, message: result.message });
        case "already-requested":
            return finishItem(importId, position, { status: "already-requested", ...found, message: result.message });
        case "unreleased":
            return finishItem(importId, position, { status: "unreleased", ...found, message: result.message });
        case "not-found":
            return finishItem(importId, position, { status: "not-found", ...found, message: result.message });
        case "upstream":
            return upstreamFailure(importId, item, result.message);
        case "too-many":
            // the account has its ceiling of requests waiting or downloading: wait for some to finish, the item stays pending
            await sleep((result.retryAfterSeconds ?? 60) * 1000);
            return;
        default:
            return finishItem(importId, position, { status: "error", ...found, message: result.message });
    }
}

// ---------------------------------------------------------------- privacy

/** Every import of a user, items included (account erasure). Returns how many imports went. */
export async function deleteImportsForUser(userId: string): Promise<number> {
    const ids = (await getRequestsDb().prepare(`SELECT id FROM imports WHERE userId = ?`).all<{ id: string }>(userId)).map((row) => row.id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    await getRequestsDb().prepare(`DELETE FROM import_items WHERE importId IN (${placeholders})`).run(...ids);
    await getRequestsDb().prepare(`DELETE FROM imports WHERE id IN (${placeholders})`).run(...ids);
    return ids.length;
}

/** What an account export carries: every import and the tracks that were in it. */
export async function listImportExportForUser(userId: string): Promise<Array<ImportJob & { items: ImportItem[] }>> {
    const rows = await getRequestsDb().prepare(`SELECT id FROM imports WHERE userId = ? ORDER BY createdAt`).all<{ id: string }>(userId);
    const out: Array<ImportJob & { items: ImportItem[] }> = [];
    for (const row of rows) {
        const job = await getImport(row.id, userId);
        if (job) out.push(job);
    }
    return out;
}

/** Finished imports older than the retention window (storage limitation). Returns how many went. */
export async function pruneFinishedImports(retentionDays = IMPORT_RETENTION_DAYS): Promise<number> {
    const cutoff = now() - retentionDays * 24 * 3600;
    const ids = (await getRequestsDb().prepare(`SELECT id FROM imports WHERE status = 'completed' AND updatedAt < ? LIMIT 500`).all<{ id: string }>(cutoff)).map((row) => row.id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    await getRequestsDb().prepare(`DELETE FROM import_items WHERE importId IN (${placeholders})`).run(...ids);
    await getRequestsDb().prepare(`DELETE FROM imports WHERE id IN (${placeholders})`).run(...ids);
    return ids.length;
}
