import { randomUUID, UUID } from "node:crypto";
import { getRequestsDb, sqlInt } from "./db";
import { NafynRequest, RequestStatus } from "../entity/NafynRequest";
import { getUserById } from "./users";
import { getMediaInfo } from "../utils/musicbrainz";
import type { MediaInfo } from "../entity/media/MediaInfo";

interface RequestRow {
    id: string,
    musicbrainzId: string,
    type: "album" | "track",
    status: RequestStatus,
    requestedBy: string,
    title: string | null,
    artistName: string | null,
    coverArt: string | null,
    createdAt: number,
    updatedAt: number
}

// builds the lightweight MediaInfo from the columns stored on the request row itself
// (no MusicBrainz call: avoids rate-limiting/slowdowns on every request read)
function infoFromRow(row: Pick<RequestRow, "musicbrainzId" | "type" | "title" | "artistName" | "coverArt">): MediaInfo | null {
    if (!row.title) return null;

    return {
        id: row.musicbrainzId,
        title: row.title,
        artist: row.artistName ?? "Unknown Artist",
        album: null,
        type: row.type,
        coverArt: row.coverArt,
        releaseDate: null,
        inLibrary: null,
        duration: 0,
        label: null
    };
}

async function rowToRequest(row: RequestRow): Promise<NafynRequest> {
    return {
        id: row.id as UUID,
        musicbrainzId: row.musicbrainzId as UUID,
        info: infoFromRow(row),
        type: row.type,
        status: row.status,
        requestedBy: await getUserById(row.requestedBy as UUID, true) ?? row.requestedBy as UUID,
        createdAt: new Date(row.createdAt * 1000),
        updatedAt: new Date(row.updatedAt * 1000)
    };
}

// creates a request, starts at "waiting" status; fetches MediaInfo once here and stores the
// display fields (title/artistName/coverArt) so later reads never have to call MusicBrainz again
export async function createRequest(musicbrainzId: UUID, type: "album" | "track", requestedBy: UUID, defaultStatus: RequestStatus = "waiting"): Promise<NafynRequest> {
    const info: MediaInfo | null = await getMediaInfo(musicbrainzId, type).catch(() => null);
    const artistName = info ? (typeof info.artist === "string" ? info.artist : info.artist.name) : null;

    const request: NafynRequest = {
        id: randomUUID(),
        musicbrainzId,
        info,
        type,
        status: defaultStatus,
        requestedBy,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    await getRequestsDb().prepare(`
        INSERT INTO requests (id, musicbrainzId, type, status, requestedBy, title, artistName, coverArt, createdAt, updatedAt)
        VALUES (:id, :musicbrainzId, :type, :status, :requestedBy, :title, :artistName, :coverArt, :createdAt, :updatedAt)
    `).run({
        id: request.id,
        musicbrainzId: request.musicbrainzId,
        type: request.type,
        status: request.status,
        requestedBy: request.requestedBy,
        title: info?.title ?? null,
        artistName,
        coverArt: info?.coverArt ?? null,
        createdAt: Math.floor(request.createdAt.getTime() / 1000),
        updatedAt: Math.floor(request.updatedAt.getTime() / 1000)
    });

    return request;
}

export async function getRequestById(id: string): Promise<NafynRequest | null> {
    const row = await getRequestsDb().prepare(`SELECT * FROM requests WHERE id = ?`).get(id) as RequestRow | undefined;
    return row ? rowToRequest(row) : null;
}

export async function listRequests(limit?: number, offset?: number): Promise<NafynRequest[]> {
    let sql = `SELECT * FROM requests ORDER BY createdAt DESC, id ASC`;
    if (limit !== undefined) {
        sql += ` LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset ?? 0)}`;
    }
    const rows = await getRequestsDb().prepare(sql).all() as RequestRow[];
    return Promise.all(rows.map(rowToRequest));
}

export async function countRequests(): Promise<number> {
    const row = await getRequestsDb().prepare(`SELECT COUNT(*) AS count FROM requests`).get() as { count: number };
    return Number(row.count);
}

export async function listRequestsByStatus(status: RequestStatus): Promise<NafynRequest[]> {
    const rows = await getRequestsDb().prepare(`SELECT * FROM requests WHERE status = ? ORDER BY createdAt DESC`).all(status) as RequestRow[];
    return Promise.all(rows.map(rowToRequest));
}

export async function listRequestsByUser(requestedBy: string, limit?: number, offset?: number): Promise<NafynRequest[]> {
    let sql = `SELECT * FROM requests WHERE requestedBy = ? ORDER BY createdAt DESC, id ASC`;
    const params: unknown[] = [requestedBy];
    if (limit !== undefined) {
        sql += ` LIMIT ${sqlInt(limit)} OFFSET ${sqlInt(offset ?? 0)}`;
    }
    const rows = await getRequestsDb().prepare(sql).all(...params) as RequestRow[];
    return Promise.all(rows.map(rowToRequest));
}

export async function countRequestsByUser(requestedBy: string): Promise<number> {
    const row = await getRequestsDb().prepare(`SELECT COUNT(*) AS count FROM requests WHERE requestedBy = ?`).get(requestedBy) as { count: number };
    return Number(row.count);
}

export async function updateRequestStatus(id: UUID | string, status: RequestStatus, checkValidity: boolean = false): Promise<NafynRequest | null> {
    let req: NafynRequest | null = await getRequestById(id);
    if (!req) return null;
    if (req.status !== "waiting" && checkValidity) return null;

    // with checkValidity the "still waiting" condition is part of the UPDATE itself, so two managers
    // accepting/denying the same request at once can't both win (and both fire a notification)
    const result = await getRequestsDb().prepare(`
        UPDATE requests SET status = ?, updatedAt = ? WHERE id = ?${checkValidity ? ` AND status = 'waiting'` : ""}
    `).run(status, Math.floor(Date.now() / 1000), id);

    req.status = status;

    if (result.changes === 0) return null;
    return req;
}

// true if this user already has a request for this MusicBrainz ID that hasn't reached an end state:
// waiting for a manager, or being worked on. Completed, failed and denied ones don't count - a completed
// request whose track was later deleted from the library, a failed download and a denied request must all be
// requestable again. This is what stops the Request button creating the same request over and over.
export async function hasActiveRequest(requestedBy: string, musicbrainzId: string): Promise<boolean> {
    const row = await getRequestsDb().prepare(`
        SELECT 1 FROM requests
        WHERE requestedBy = ? AND musicbrainzId = ? AND status IN ('waiting', 'searching', 'downloading', 'processing')
        LIMIT 1
    `).get(requestedBy, musicbrainzId);
    return row != null;
}

export async function deleteRequest(id: string): Promise<boolean> {
    const result = await getRequestsDb().prepare(`DELETE FROM requests WHERE id = ?`).run(id);
    return result.changes > 0;
}

/**
 * Deletes a request unless the pipeline is working on it. The "not active" condition is part of the DELETE
 * itself, so a request that a manager accepts a moment before someone else deletes it can't slip through a
 * check-then-delete gap.
 */
export async function deleteRequestIfIdle(id: string): Promise<"deleted" | "active" | "missing"> {
    const db = getRequestsDb();
    const result = await db.prepare(
        `DELETE FROM requests WHERE id = ? AND status NOT IN ('searching', 'downloading', 'processing')`
    ).run(id);
    if (result.changes > 0) return "deleted";

    const stillThere = await db.prepare(`SELECT 1 FROM requests WHERE id = ?`).get(id);
    return stillThere ? "active" : "missing";
}

// erasure helper (GDPR art. 17). A request row is an operational record of what the instance downloaded,
// which survives the account that asked for it - but `requestedBy` is a personal identifier, so it is
// nulled rather than the row being dropped. The column is nullable precisely so this is possible, and
// every reader already treats a null requester as "unknown".
export async function anonymizeRequestsOfUser(userId: string): Promise<number> {
    const result = await getRequestsDb().prepare(`
        UPDATE requests SET requestedBy = NULL, updatedAt = ? WHERE requestedBy = ?
    `).run(Date.now(), userId);
    return result.changes;
}
