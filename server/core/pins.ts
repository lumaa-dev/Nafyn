// pins: the albums, playlists and tracks a user keeps at hand. They are shown as a grid on the Library home and
// at the top of the Tracks page. There is no limit per user.
//
// A pin is just (user, kind, refId). What it points at is resolved when the list is read, against what the
// user can still see, and a pin whose target is gone (track deleted from the library, playlist deleted or no
// longer shared) is dropped right there instead of being tracked on every deletion path.
import { randomUUID } from "node:crypto";
import { getLibrariesDb } from "./db";
import { findLibraryEntry, getAlbumOfUser, userOwnsAlbum, type AlbumRow, type MediaRow } from "./library";
import { getPlaylistById, hasAccess } from "./playlists";

export const PIN_KINDS = ["album", "playlist", "track"] as const;
export type PinKind = typeof PIN_KINDS[number];

export function isPinKind(value: unknown): value is PinKind {
    return typeof value === "string" && (PIN_KINDS as readonly string[]).includes(value);
}

export interface PinEntry {
    kind: PinKind,
    refId: string,
    pinnedAt: number,
    title: string,
    subtitle: string | null,
    /** where clicking the pin goes */
    href: string,
    coverArt: string | null,
    /** media ID of a track carrying an uploaded cover (albums) */
    coverMediaId: string | null,
    /** the track itself (kind "track"), so a client can play it straight away */
    media: MediaRow | null,
    /** the playlist's uploaded-cover version token (kind "playlist") */
    playlistImage: string | null,
    /** kind "playlist": the viewer owns it / was invited to it (decides Delete or Leave in its menu) */
    isOwner: boolean,
    isMember: boolean
}

interface PinRow {
    id: string,
    userId: string,
    kind: PinKind,
    refId: string,
    pinnedAt: number
}

// can this user pin (= see) the target? Same rule the rest of the app uses to show it to them.
export async function canPin(userId: string, kind: PinKind, refId: string): Promise<boolean> {
    if (kind === "track") return !!await findLibraryEntry(userId, refId);
    if (kind === "album") return await userOwnsAlbum(userId, refId);

    const playlist = await getPlaylistById(refId);
    return !!playlist && (playlist.privacy === "public" || await hasAccess(playlist, userId));
}

// idempotent: pinning twice keeps the first pin (and its place in the grid)
export async function addPin(userId: string, kind: PinKind, refId: string): Promise<void> {
    await getLibrariesDb().prepare(`
        INSERT IGNORE INTO user_pins (id, userId, kind, refId, pinnedAt) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), userId, kind, refId, Date.now());
}

export async function removePin(userId: string, kind: PinKind, refId: string): Promise<boolean> {
    const result = await getLibrariesDb().prepare(`DELETE FROM user_pins WHERE userId = ? AND kind = ? AND refId = ?`).run(userId, kind, refId);
    return result.changes > 0;
}

export async function deletePinsForUser(userId: string): Promise<number> {
    const result = await getLibrariesDb().prepare(`DELETE FROM user_pins WHERE userId = ?`).run(userId);
    return result.changes;
}

// data-access export (GDPR art. 15)
export async function listPinExportForUser(userId: string): Promise<{ kind: PinKind, refId: string, pinnedAt: number }[]> {
    return await getLibrariesDb().prepare(`SELECT kind, refId, pinnedAt FROM user_pins WHERE userId = ? ORDER BY pinnedAt ASC`).all(userId) as { kind: PinKind, refId: string, pinnedAt: number }[];
}

// the pinned items the user can still see, newest pin first. Stale pins are deleted on the way.
export async function listPins(userId: string): Promise<PinEntry[]> {
    const db = getLibrariesDb();
    const rows = await db.prepare(`SELECT * FROM user_pins WHERE userId = ? ORDER BY pinnedAt DESC, id ASC`).all(userId) as PinRow[];
    if (rows.length === 0) return [];

    const trackIds = rows.filter((row) => row.kind === "track").map((row) => row.refId);
    const tracks = new Map<string, MediaRow>();
    if (trackIds.length > 0) {
        const found = await db.prepare(`
            SELECT media.* FROM library_entries
            JOIN media ON media.id = library_entries.mediaId
            WHERE library_entries.userId = ? AND media.id IN (${trackIds.map(() => "?").join(", ")})
        `).all(userId, ...trackIds) as MediaRow[];
        for (const media of found) tracks.set(media.id, media);
    }

    const entries: PinEntry[] = [];
    const stale: PinRow[] = [];

    for (const row of rows) {
        const base = { kind: row.kind, refId: row.refId, pinnedAt: row.pinnedAt, subtitle: null, coverArt: null, coverMediaId: null, media: null, playlistImage: null, isOwner: false, isMember: false };

        if (row.kind === "track") {
            const media = tracks.get(row.refId);
            if (!media) { stale.push(row); continue; }
            entries.push({ ...base, title: media.title, subtitle: media.artistName, href: `/l/t/${media.id}`, coverArt: media.coverArt, media });
        } else if (row.kind === "album") {
            const album: AlbumRow | null = await getAlbumOfUser(userId, row.refId);
            if (!album) { stale.push(row); continue; }
            entries.push({ ...base, title: album.title, subtitle: album.artistName, href: `/l/a/${album.id}`, coverArt: album.coverArt, coverMediaId: album.coverMediaId });
        } else {
            const playlist = await getPlaylistById(row.refId);
            if (!playlist || !(playlist.privacy === "public" || await hasAccess(playlist, userId))) { stale.push(row); continue; }
            const isOwner = playlist.ownerId === userId;
            entries.push({ ...base, title: playlist.title, href: `/l/playlist/${playlist.id}`, playlistImage: playlist.image, isOwner, isMember: !isOwner && await hasAccess(playlist, userId) });
        }
    }

    for (const row of stale) await removePin(userId, row.kind, row.refId);
    return entries;
}
