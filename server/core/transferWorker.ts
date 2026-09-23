// processes library imports (Settings -> Import).
//
// A job moves through three stages:
//   fetching     read the source library through the provider's API (needs the in-memory session token)
//   matching     map every item onto a MusicBrainz ID (ISRC/UPC first, strict search fallback)
//   downloading  hand each match to the regular download pipeline, one at a time, in source order
//
// Imported items skip the "waiting" approval state entirely: their requests are created straight in
// "searching" and processed immediately, exactly as for an AUTOACCEPT account - whatever the importing
// account's AUTOACCEPT bits say. The REQUEST_TRACKS / REQUEST_ALBUMS bits are still enforced per item.
//
// Two in-process loops, no queue: one matcher (bound by MusicBrainz's 1 request/second) and one downloader
// (bound by Soulseek), both driven off the transfer_* tables so a restart resumes where it left off. Items
// are claimed with conditional UPDATEs, and NAFYN_TRANSFER_WORKER=false makes a replica stand down.
import type { UUID } from "node:crypto";
import type { TransferProviderId, TransferSelection } from "../entity/Transfer";
import type { MediaInfo } from "../entity/media/MediaInfo";
import { hasPermission, Permission } from "../entity/Permission";
import type { ProviderSession, SourceAlbum, SourceArtist, SourceTrack, TransferProvider } from "../utils/transfer/types";
import { dropTransferSession } from "../utils/transfer/sessions";
import { matchAlbum, matchArtist, matchTrack } from "../utils/transfer/match";
import type { ParsedFileImport } from "../utils/transfer/fileImport";
import { TransferHttpError } from "../utils/transfer/http";
import {
    claimTransferItem,
    countTransferItemsWithStatus,
    createTransferPlaylist,
    getTransferJobRow,
    getTransferPlaylist,
    insertTransferItems,
    listTransferItemsWithStatus,
    listTransferJobIdsWithStatus,
    markTransferJobTruncated,
    nextItemToDownload,
    nextItemToMatch,
    setTransferJobStatus,
    setTransferPlaylistTarget,
    touchTransferJob,
    transitionTransferJob,
    updateTransferItem,
    type NewTransferItem,
    type TransferItemRow
} from "./transfer";
import { createRequest, getRequestById, updateRequestStatus } from "./requests";
import { processDownloadRequest } from "./downloads";
import { findLibraryEntry, findMediaByMusicbrainzId } from "./library";
import { addEntries, createPlaylist, getPlaylistById } from "./playlists";
import { getPermissionsById } from "./users";

// generous for a personal library, and a hard stop against a runaway source
export const MAX_ITEMS_PER_JOB = 10_000;
const IDLE_POLL_MS = 15_000;

// -- fetching --

function trackItem(t: SourceTrack, source: NewTransferItem["source"], playlistRef: string | null = null): NewTransferItem {
    return {
        kind: "track", source, playlistRef,
        externalId: t.externalId, title: t.title, artistName: t.artist, albumName: t.album,
        isrc: t.isrc, upc: null, durationMs: t.durationMs, unsupported: t.unsupported
    };
}

function albumItem(a: SourceAlbum, source: NewTransferItem["source"]): NewTransferItem {
    return { kind: "album", source, playlistRef: null, externalId: a.externalId, title: a.title, artistName: a.artist, albumName: a.title, isrc: null, upc: a.upc, durationMs: null };
}

function artistItem(a: SourceArtist): NewTransferItem {
    return { kind: "artist", source: "artist", playlistRef: null, externalId: a.externalId, title: a.name, artistName: a.name, albumName: null, isrc: null, upc: null, durationMs: null };
}

// user-facing error text: which service failed and how, never the token or a raw stack
function describeFetchError(provider: TransferProviderId, err: unknown): string {
    if (err instanceof TransferHttpError) {
        if (err.status === 401 || err.status === 403) return `${provider}: access was refused (${err.status}). Try connecting again.`;
        return `${provider}: ${err.message}`;
    }
    return `${provider}: ${err instanceof Error ? err.message : "unknown error"}`;
}

// reads the selected parts of the source library into transfer_items. Runs in the background; the job row
// is what the UI follows.
export async function runTransferFetch(jobId: string, provider: TransferProvider, session: ProviderSession, selection: TransferSelection, playlistTitles: Map<string, string>): Promise<void> {
    let budget = MAX_ITEMS_PER_JOB;
    let truncated = false;
    const take = <T>(items: T[]) => {
        if (items.length > budget) truncated = true;
        const kept = items.slice(0, Math.max(budget, 0));
        budget -= kept.length;
        return kept;
    };

    try {
        if (selection.likedTracks && provider.likedTracks && budget > 0) {
            const tracks = take(await provider.likedTracks(session, budget + 1));
            await insertTransferItems(jobId, tracks.map((t) => trackItem(t, "liked")));
        }

        for (const playlistId of selection.playlists) {
            if (!provider.playlistTracks || budget <= 0) break;
            const tracks = take(await provider.playlistTracks(session, playlistId, budget + 1));
            const playlist = await createTransferPlaylist(jobId, playlistId, playlistTitles.get(playlistId) ?? "Imported playlist", null);
            await insertTransferItems(jobId, tracks.map((t) => trackItem(t, "playlist", playlist.id)));
        }

        if (selection.albums && provider.albums && budget > 0) {
            const albums = take(await provider.albums(session, budget + 1));
            await insertTransferItems(jobId, albums.map((a) => albumItem(a, "album")));
        }

        if (selection.artists && provider.artists && budget > 0) {
            const artists = take(await provider.artists(session, budget + 1));
            await insertTransferItems(jobId, artists.map(artistItem));
        }

        if (truncated) await markTransferJobTruncated(jobId);
        // a cancel while fetching has already moved the job on; this only advances a job still fetching
        await transitionTransferJob(jobId, "fetching", "matching");
        wakeTransferWorker();
    } catch (err) {
        console.error(`[transfer] fetching job ${jobId} from ${provider.id} failed:`, err);
        await setTransferJobStatus(jobId, "failed", describeFetchError(provider.id, err)).catch(() => {});
    } finally {
        // the token has done its job - don't keep it around for the rest of the session TTL
        dropTransferSession(session.id);
    }
}

// a parsed file needs no fetching; its items go straight in and the job starts at "matching"
export async function insertFileImport(jobId: string, parsed: ParsedFileImport): Promise<void> {
    let budget = MAX_ITEMS_PER_JOB;
    let truncated = false;
    const take = <T>(items: T[]) => {
        if (items.length > budget) truncated = true;
        const kept = items.slice(0, Math.max(budget, 0));
        budget -= kept.length;
        return kept;
    };

    await insertTransferItems(jobId, take(parsed.tracks).map((t) => trackItem(t, "file")));
    for (const playlist of parsed.playlists) {
        if (budget <= 0) break;
        const ref = await createTransferPlaylist(jobId, null, playlist.title, null);
        await insertTransferItems(jobId, take(playlist.tracks).map((t) => trackItem(t, "playlist", ref.id)));
    }
    await insertTransferItems(jobId, take(parsed.albums).map((a) => albumItem(a, "file")));
    if (truncated) await markTransferJobTruncated(jobId);
}

// -- matching --

async function matchOne(item: TransferItemRow): Promise<void> {
    if (!await claimTransferItem(item.id, "pending", "matching")) return;

    try {
        const result = item.kind === "track"
            ? await matchTrack({ title: item.title, artist: item.artistName, album: item.albumName, isrc: item.isrc, durationMs: item.durationMs })
            : item.kind === "album"
                ? await matchAlbum({ title: item.title, artist: item.artistName, upc: item.upc })
                : await matchArtist(item.title);

        if ("failReason" in result) {
            await updateTransferItem(item.id, { status: "failed", failReason: result.failReason });
        } else {
            // artists aren't downloaded (there's no "whole discography" request) - matching them is the import:
            // the report links each one to its Nafyn artist page
            await updateTransferItem(item.id, {
                status: item.kind === "artist" ? "completed" : "matched",
                musicbrainzId: result.musicbrainzId,
                matchedBy: result.matchedBy
            });
        }
    } catch (err) {
        // a MusicBrainz outage shouldn't burn through the whole queue as "not found" - put it back and let
        // the loop back off
        await updateTransferItem(item.id, { status: "pending" });
        throw err;
    }
    await touchTransferJob(item.jobId);
}

async function matchStep(): Promise<boolean> {
    const item = await nextItemToMatch();
    if (item) {
        await matchOne(item);
        return true;
    }

    // every item matched (or failed): move those jobs on to downloading
    let advanced = false;
    for (const jobId of await listTransferJobIdsWithStatus("matching")) {
        if (await countTransferItemsWithStatus(jobId, ["pending", "matching"]) === 0) {
            advanced = await transitionTransferJob(jobId, "matching", "downloading") || advanced;
        }
    }
    return advanced;
}

// -- downloading --

async function addToImportedPlaylist(item: TransferItemRow, userId: string, mediaId: string): Promise<void> {
    if (!item.playlistRef) return;
    const source = await getTransferPlaylist(item.playlistRef);
    if (!source) return;

    let playlistId = source.nafynPlaylistId;
    if (playlistId) {
        // the user deleted the imported playlist while the import was still running - respect that
        if (!await getPlaylistById(playlistId)) return;
    } else {
        // created on the first track that actually lands, so a playlist where nothing matched never
        // shows up as an empty shell
        const created = await createPlaylist(userId, source.title, source.description, "private");
        await setTransferPlaylistTarget(source.id, created.id);
        playlistId = created.id;
    }

    await addEntries(playlistId, [mediaId], userId);
}

async function finishTrack(item: TransferItemRow, userId: string, alreadyOwned: boolean): Promise<void> {
    if (item.kind === "track" && item.musicbrainzId) {
        const media = await findMediaByMusicbrainzId(item.musicbrainzId);
        if (media) await addToImportedPlaylist(item, userId, media.id).catch((err) => console.error("[transfer] adding to playlist failed:", err));
    }
    await updateTransferItem(item.id, { status: "completed", alreadyOwned: alreadyOwned ? 1 : 0 });
}

function knownInfo(item: TransferItemRow): MediaInfo {
    return {
        id: item.musicbrainzId!,
        title: item.title ?? "Unknown",
        artist: item.artistName ?? "Unknown Artist",
        album: null,
        type: item.kind === "album" ? "album" : "track",
        coverArt: item.kind === "album" ? `https://coverartarchive.org/release-group/${item.musicbrainzId}/front-250` : null,
        releaseDate: null,
        inLibrary: null,
        duration: 0,
        label: null,
        relations: { amId: undefined }
    };
}

async function downloadOne(item: TransferItemRow): Promise<void> {
    const job = await getTransferJobRow(item.jobId);
    if (!job || job.status !== "downloading" || !item.musicbrainzId) return;
    if (!await claimTransferItem(item.id, "matched", "requested")) return;

    const userId = job.userId;
    const type = item.kind === "album" ? "album" : "track";

    // SECURITY: importing skips the approval queue, never the permission to request at all
    const permissions = await getPermissionsById(userId) ?? 0;
    if (!hasPermission(permissions, type === "album" ? Permission.REQUEST_ALBUMS : Permission.REQUEST_TRACKS)) {
        await updateTransferItem(item.id, { status: "failed", failReason: "no_permission" });
        return;
    }

    // already in this user's library (an earlier import, a manual request, a duplicate within the same
    // source): nothing to download, but it still belongs in the imported playlist
    if (type === "track") {
        const media = await findMediaByMusicbrainzId(item.musicbrainzId);
        if (media && await findLibraryEntry(userId, media.id)) {
            await finishTrack(item, userId, true);
            return;
        }
    }

    // straight to "searching": the approval bypass that makes imports behave like AUTOACCEPT
    const request = await createRequest(item.musicbrainzId as UUID, type, userId as UUID, "searching", knownInfo(item));
    await updateTransferItem(item.id, { requestId: request.id });

    await processDownloadRequest(request);

    const finished = await getRequestById(request.id);
    if (finished?.status === "completed") {
        await finishTrack(item, userId, false);
    } else {
        await updateTransferItem(item.id, { status: "failed", failReason: "download_failed" });
    }
    await touchTransferJob(item.jobId);
}

async function downloadStep(): Promise<boolean> {
    const item = await nextItemToDownload();
    if (item) {
        await downloadOne(item);
        return true;
    }

    for (const jobId of await listTransferJobIdsWithStatus("downloading")) {
        if (await countTransferItemsWithStatus(jobId, ["pending", "matching", "matched", "requested"]) === 0) {
            await transitionTransferJob(jobId, "downloading", "completed");
        }
    }
    return false;
}

// -- loops --

const wakers = new Set<() => void>();

export function wakeTransferWorker(): void {
    for (const wake of [...wakers]) wake();
}

function idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            wakers.delete(done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        wakers.add(done);
    });
}

async function loop(name: string, step: () => Promise<boolean>): Promise<void> {
    let failures = 0;
    for (;;) {
        let worked = false;
        try {
            worked = await step();
            failures = 0;
        } catch (err) {
            failures++;
            console.error(`[transfer] ${name} step failed:`, err);
        }
        if (failures > 0) await idle(Math.min(60_000, 2000 * 2 ** failures));
        else if (!worked) await idle(IDLE_POLL_MS);
    }
}

// puts in-flight work back into a consistent state after a restart
async function recover(): Promise<void> {
    // a fetch needs the provider token, which only ever lived in memory
    for (const jobId of await listTransferJobIdsWithStatus("fetching")) {
        await setTransferJobStatus(jobId, "failed", "Interrupted by a server restart while reading the library. Please connect and import again.");
    }

    for (const item of await listTransferItemsWithStatus("matching")) {
        await updateTransferItem(item.id, { status: "pending" });
    }

    // a download that was running when the process died: count it if it actually finished, otherwise
    // fail the orphaned request and queue the item again
    for (const item of await listTransferItemsWithStatus("requested")) {
        const request = item.requestId ? await getRequestById(item.requestId) : null;
        const job = await getTransferJobRow(item.jobId);
        if (request?.status === "completed" && job) {
            await finishTrack(item, job.userId, false);
            continue;
        }
        if (request && request.status !== "failed") await updateRequestStatus(request.id, "failed");
        await updateTransferItem(item.id, job?.status === "downloading" ? { status: "matched", requestId: null } : { status: "skipped" });
    }
}

let started = false;

export async function startTransferWorker(): Promise<void> {
    if (started) return;
    started = true;

    // the db plugin creates the tables asynchronously; wait for them rather than assume plugin ordering
    for (let attempt = 0; ; attempt++) {
        try {
            await recover();
            break;
        } catch (err) {
            if (attempt >= 20) {
                console.error("[transfer] could not start the import worker:", err);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    }

    void loop("matcher", matchStep);
    void loop("downloader", downloadStep);
}
