import { randomUUID, UUID } from "node:crypto";
import { getRequestsDb } from "./db";
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

export async function listRequests(): Promise<NafynRequest[]> {
    const rows = await getRequestsDb().prepare(`SELECT * FROM requests ORDER BY createdAt DESC`).all() as RequestRow[];
    return Promise.all(rows.map(rowToRequest));
}

export async function listRequestsByStatus(status: RequestStatus): Promise<NafynRequest[]> {
    const rows = await getRequestsDb().prepare(`SELECT * FROM requests WHERE status = ? ORDER BY createdAt DESC`).all(status) as RequestRow[];
    return Promise.all(rows.map(rowToRequest));
}

export async function listRequestsByUser(requestedBy: string): Promise<NafynRequest[]> {
    const rows = await getRequestsDb().prepare(`SELECT * FROM requests WHERE requestedBy = ? ORDER BY createdAt DESC`).all(requestedBy) as RequestRow[];
    return Promise.all(rows.map(rowToRequest));
}

export async function updateRequestStatus(id: UUID | string, status: RequestStatus, checkValidity: boolean = false): Promise<NafynRequest | null> {
    let req: NafynRequest | null = await getRequestById(id);
    if (!req) return null;
    if (req.status !== "waiting" && checkValidity) return null;

    const result = await getRequestsDb().prepare(`
        UPDATE requests SET status = ?, updatedAt = ? WHERE id = ?
    `).run(status, Math.floor(Date.now() / 1000), id);

    req.status = status;

    if (result.changes === 0) return null;
    return req;
}

// true if this user already has a non-failed request for this MusicBrainz ID (failed ones can be retried)
export async function hasActiveRequest(requestedBy: string, musicbrainzId: string): Promise<boolean> {
    const row = await getRequestsDb().prepare(`
        SELECT 1 FROM requests WHERE requestedBy = ? AND musicbrainzId = ? AND status != 'failed' LIMIT 1
    `).get(requestedBy, musicbrainzId);
    return row != null;
}

export async function deleteRequest(id: string): Promise<boolean> {
    const result = await getRequestsDb().prepare(`DELETE FROM requests WHERE id = ?`).run(id);
    return result.changes > 0;
}
