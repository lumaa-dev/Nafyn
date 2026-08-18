// all the Soulseek downloads are handled here
//
// pipeline:
//   1. Search song(s) with title, artist, album info
//   2. Match data with MusicBrainz
//   3. Check if song is already downloaded by anyone (if found, just grant the requesting user access to that file)
//   4. Get song(s) through Soulseek API
//   5. Verify song(s) fingerprint with AcoustID
//   6. Edit audio file metadata with song info from MusicBrainz (fetched in step 2)
//   7. Write the song once under music/{mediaId}.ext and grant the requesting user access
//   8. Set request status to "completed"
//
// security/anonymity notes:
//   - downloads go through a self-hosted slskd instance (see utils/soulseek.ts); what it shares back to the
//     Soulseek network is entirely its own configuration, outside this app's control
//   - peer-supplied filenames are never trusted for anything beyond a whitelisted extension; every file we
//     write uses our own random/UUID-derived name, so a malicious peer can't path-traverse or spoof identity
//     through its filename
//   - a download is rejected if its AcoustID fingerprint doesn't match the requested MusicBrainz recording AND
//     its duration is off by more than a few seconds; fingerprint alone is too unreliable (AcoustID frequently
//     lacks a given recording ID) to gate on by itself, so duration backs it up as the stronger "wrong file" signal
//   - true network-level anonymity (hiding your IP from Soulseek peers) isn't something the protocol supports;
//     use a dedicated/throwaway Soulseek account and, if you need IP-level anonymity too, run slskd itself
//     behind a VPN at the infrastructure level

import { randomUUID, UUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import type { IRelease, IReleaseGroup, MusicBrainzApi } from "musicbrainz-api";
import type { SlskSearchResult } from "../utils/soulseek";
import { getMusicBrainzClient, getAppleMusicTrackID } from "../utils/musicbrainz";
import { searchSoulseek, downloadFromSoulseek } from "../utils/soulseek";
import { verifyRecordingMatch } from "../utils/fingerprint";
import { tagAudioFile } from "../utils/audioTag";
import { getRequestById, updateRequestStatus } from "./requests";
import {
    findMediaByMusicbrainzId,
    findAnyLibraryEntryForMedia,
    findLibraryEntry,
    insertMedia,
    addLibraryEntry,
    shareMediaWithUser,
    libraryFilePath,
    updateMediaFileSize
} from "./library";
import { emitDownloadProgress, clearDownloadEmitter } from "../utils/downloadEvents";
import { NafynRequest } from "../entity/NafynRequest";

const TMP_DIR = join(process.cwd(), ".data", "tmp");
const ALLOWED_EXTENSIONS = [".mp3", ".flac", ".ogg", ".m4a", ".wav"];
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_CANDIDATES_PER_TRACK = 5;
const MAX_DURATION_DELTA_SECONDS = 5;

// filenames carrying one of these words are a different version of the track (same duration as the original
// is common for instrumentals/acapellas), so duration alone can't be trusted to wave a mismatched fingerprint
// through - only exclude when the requested title itself isn't asking for that version
const EXCLUDED_VERSION_KEYWORDS = ["instrumental", "acapella", "a cappella", "karaoke", "backing track", "no vocal", "no vocals"];

interface TrackTarget {
    recordingId: string,
    title: string,
    artistName: string,
    artistMbid: string,
    album: string | null,
    albumId: string,
    albumType: "album" | "ep" | null,
    trackNumber: number | null,
    releaseDate: Date | null,
    duration: number,
    label: string | null,
    coverArt: string | null,
    amId: string | null
}

function parseReleaseDate(date: string | undefined): Date | null {
    if (!date) return null;
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// step 2: resolve the request's MusicBrainz ID into one (track) or many (album) concrete recordings to fetch
async function resolveTargets(client: MusicBrainzApi, musicbrainzId: string, type: "album" | "track"): Promise<TrackTarget[]> {
    if (type === "track") {
        const recording = await client.lookup("recording", musicbrainzId, ["artist-credits", "releases", "release-groups", "url-rels"]);
        const release = recording.releases?.[0];
        const credit = recording["artist-credit"]?.[0]?.artist;

        // albumId must be the release-*group* MBID (not the release's own ID) so the library's
        // "album" grouping links back to a valid /api/v1/album/{aid} target
        return [{
            recordingId: recording.id,
            title: recording.title,
            artistName: credit?.name ?? "Unknown Artist",
            artistMbid: credit?.id ?? "unknown-artist",
            album: release?.title ?? null,
            albumId: release?.["release-group"]?.id ?? "unknown-album",
            albumType: null,
            trackNumber: null,
            releaseDate: parseReleaseDate(recording["first-release-date"]),
            duration: recording.length ? Math.round(recording.length / 1000) : 0,
            label: null,
            coverArt: release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
            amId: getAppleMusicTrackID(recording, release) ?? null
        }];
    }

    const releaseGroup: IReleaseGroup = await client.lookup("release-group", musicbrainzId, ["artist-credits"]);
    const browsed = await client.browse("release", { "release-group": musicbrainzId }, ["recordings", "artist-credits", "labels", "media"]);
    const release: IRelease | undefined = browsed.releases[0];
    if (!release) return [];

    const primaryType = releaseGroup["primary-type"]?.toLowerCase();
    const albumType = primaryType === "album" || primaryType === "ep" ? primaryType : null;
    const label = release["label-info"]?.[0]?.label?.name ?? null;
    const releaseArtist = releaseGroup["artist-credit"]?.[0]?.artist;
    const releaseDate = parseReleaseDate(releaseGroup["first-release-date"]);
    const coverArt = `https://coverartarchive.org/release-group/${musicbrainzId}/front-250`;
    const amId = getAppleMusicTrackID(undefined, release) ?? null;

    const targets: TrackTarget[] = [];
    for (const medium of release.media ?? []) {
        for (const track of medium.tracks ?? []) {
            const trackArtist = track["artist-credit"]?.[0]?.artist ?? releaseArtist;
            targets.push({
                recordingId: track.recording.id,
                title: track.title,
                artistName: trackArtist?.name ?? "Unknown Artist",
                artistMbid: trackArtist?.id ?? "unknown-artist",
                album: releaseGroup.title,
                albumId: releaseGroup.id,
                albumType,
                trackNumber: track.position,
                releaseDate,
                duration: track.length ? Math.round(track.length / 1000) : 0,
                label,
                coverArt,
                amId
            });
        }
    }
    return targets;
}

// only the extension is ever trusted from a peer's filename; everything else about the candidate is validated
function sanitizeCandidate(result: SlskSearchResult): { extension: string } | null {
    const name = basename(result.file.replace(/\\/g, "/"));
    const extension = extname(name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(extension)) return null;
    if (!Number.isFinite(result.size) || result.size <= 0 || result.size > MAX_FILE_SIZE) return null;
    return { extension };
}

function pickCandidates(results: SlskSearchResult[]): SlskSearchResult[] {
    return results
        .filter((result) => result.slots && sanitizeCandidate(result))
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0) || (b.speed ?? 0) - (a.speed ?? 0))
        .slice(0, MAX_CANDIDATES_PER_TRACK);
}

function normalize(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// true when `fileName` names a different version (instrumental/karaoke/...) than the one actually requested
function isExcludedVersion(fileName: string, wantedTitle: string): boolean {
    const name = normalize(fileName);
    const title = normalize(wantedTitle);
    return EXCLUDED_VERSION_KEYWORDS.some((keyword) => name.includes(keyword) && !title.includes(keyword));
}

// narrows an album-wide search down to the results that look like they're this specific track
function candidatesForTrack(results: SlskSearchResult[], target: TrackTarget): SlskSearchResult[] {
    const wantedTitle = normalize(target.title);
    if (!wantedTitle) return [];
    return results.filter((result) => {
        const name = normalize(basename(result.file.replace(/\\/g, "/"), extname(result.file)));
        return name.includes(wantedTitle) && !isExcludedVersion(name, target.title);
    });
}

// tries each query in order, returns the first one with hits
async function searchWithFallback(queries: string[]): Promise<SlskSearchResult[]> {
    for (const q of queries) {
        const results = await searchSoulseek(q);
        console.log(`[downloads] ${results.length} results for "${q}"`);
        if (results.length > 0) return results;
    }
    return [];
}

// downloading an album from N different sellers is how you end up with the same track twice under two
// different names/bitrates; instead pick the single user whose shared files best cover the MusicBrainz
// track list, and only ever match tracks against that one user's files
function pickBestAlbumUser(results: SlskSearchResult[], targets: TrackTarget[]): { user: string, files: SlskSearchResult[], matchedTracks: number } | null {
    const byUser = new Map<string, SlskSearchResult[]>();
    for (const result of results) {
        if (!result.slots || !sanitizeCandidate(result)) continue;
        const list = byUser.get(result.user) ?? [];
        list.push(result);
        byUser.set(result.user, list);
    }

    let best: { user: string, files: SlskSearchResult[], matchedTracks: number } | null = null;
    for (const [user, files] of byUser) {
        const matchedTracks = targets.filter((target) => candidatesForTrack(files, target).length > 0).length;
        if (matchedTracks === 0) continue;
        if (!best || matchedTracks > best.matchedTracks || (matchedTracks === best.matchedTracks && files.length > best.files.length)) {
            best = { user, files, matchedTracks };
        }
    }
    return best;
}

// steps 3-7 for a single recording
async function downloadTrack(
    requestId: string,
    requestedBy: string,
    target: TrackTarget,
    trackIndex: number,
    trackCount: number,
    primaryResults?: SlskSearchResult[],
    poolResults?: SlskSearchResult[]
): Promise<boolean> {
    const progress = (fields: Partial<Parameters<typeof emitDownloadProgress>[0]>) =>
        emitDownloadProgress({ requestId, trackTitle: target.title, trackIndex, trackCount, stage: "searching", ...fields });

    // step 3: already downloaded by someone else? copy instead of hitting Soulseek again
    const existingMedia = findMediaByMusicbrainzId(target.recordingId);
    if (existingMedia) {
        if (findLibraryEntry(requestedBy, existingMedia.id)) {
            progress({ stage: "completed", message: "Already in library" });
            return true;
        }

        const sourceEntry = findAnyLibraryEntryForMedia(existingMedia.id);
        if (sourceEntry) {
            shareMediaWithUser(requestedBy, existingMedia, sourceEntry.filePath);
            progress({ stage: "completed", message: "Granted access to existing library entry" });
            return true;
        }
    }

    // step 4: search + download through Soulseek
    await updateRequestStatus(requestId, "downloading");
    progress({ stage: "downloading", message: "Searching Soulseek" });

    // preferred seller's copies first, but merged with any other album-wide-search seller's copies of the
    // same track (no extra Soulseek traffic - poolResults is already in hand) so that if the preferred
    // seller stalls, the candidate loop below has a *different user's* copy to fall through to instead of
    // just giving up; a fresh per-track search is only ever used as an absolute last resort
    let results: SlskSearchResult[] = primaryResults ? candidatesForTrack(primaryResults, target) : [];
    if (poolResults) {
        const pooled = candidatesForTrack(poolResults, target)
            .filter((r) => !results.some((existing) => existing.user === r.user && existing.file === r.file));
        if (pooled.length > 0 && results.length === 0) console.log(`[downloads] "${target.title}" not found with selected seller, matched from another seller in existing results`);
        results = results.concat(pooled);
    }
    if (results.length === 0) {
        console.log(`[downloads] "${target.title}" not found in album search results, falling back to per-track search (last resort)`);
        const rawResults = await searchWithFallback([`${target.artistName} ${target.title}`, `${target.title} ${target.artistName}`]);
        results = rawResults.filter((result) => !isExcludedVersion(basename(result.file.replace(/\\/g, "/"), extname(result.file)), target.title));
    }

    const candidates = pickCandidates(results);

    if (candidates.length === 0) {
        progress({ stage: "failed", message: "No Soulseek results found" });
        return false;
    }

    console.log(`[downloads] Matching ${candidates.length} candidates`);

    for (const candidate of candidates) {
        const extension = sanitizeCandidate(candidate)!.extension;
        const tempPath = join(TMP_DIR, `${randomUUID()}${extension}`);

        try {
            await downloadFromSoulseek(candidate, tempPath, (dl) => {
                progress({
                    stage: "downloading",
                    bytesDownloaded: dl.bytesDownloaded,
                    totalBytes: dl.totalBytes,
                    speedBytesPerSec: dl.speedBytesPerSec,
                    etaSeconds: dl.etaSeconds,
                    message: `${dl.bytesDownloaded / dl.totalBytes * 100}%`
                });
            });

            // step 5: verify fingerprint
            await updateRequestStatus(requestId, "processing");
            progress({ stage: "processing", message: "Verifying fingerprint" });

            // AcoustID often has no entry for this exact recording ID even when the audio is correct, so a
            // "not matched" result alone isn't proof of a wrong file. Duration is a stronger signal of a
            // genuinely wrong file, but it can't tell an instrumental/acapella/karaoke apart from the real thing
            // since those commonly share the same runtime - that case is already filtered out of the candidate
            // list before we ever get here (see isExcludedVersion), so trusting duration at this point is safe.
            const check = await verifyRecordingMatch(tempPath, target.recordingId);
            const durationDelta = Math.abs(check.duration - target.duration);
            
            if (!check.matched && durationDelta > MAX_DURATION_DELTA_SECONDS) {
                await rm(tempPath, { force: true });
                console.log(`[downloads] ${check.fingerprint} rejected: not matched and duration off by ${durationDelta}s`);
                continue;
            }

            if (!check.matched) {
                console.log(`[downloads] ${check.fingerprint} not matched by AcoustID but duration within ${durationDelta}s, accepting`);
            } else {
                console.log(`[downloads] ${check.fingerprint} matched`);
            }

            // step 6+7: tag with MusicBrainz metadata, move into the requesting user's library
            const media = insertMedia({
                musicbrainzId: target.recordingId,
                title: target.title,
                artistName: target.artistName,
                artistMbid: target.artistMbid,
                album: target.album,
                albumId: target.albumId,
                albumType: target.albumType,
                coverArt: target.coverArt,
                releaseDate: target.releaseDate ? Math.floor(target.releaseDate.getTime() / 1000) : null,
                duration: target.duration,
                label: target.label,
                fingerprint: check.fingerprint,
                amId: target.amId,
                fileSize: null
            });

            console.log(`[downloads] Musicbrainz'd "${target.title}"`);

            const destPath = libraryFilePath(media.id, extension);
            await mkdir(dirname(destPath), { recursive: true });
            await tagAudioFile(tempPath, destPath, {
                title: target.title,
                artist: target.artistName,
                album: target.album,
                trackNumber: target.trackNumber,
                date: target.releaseDate,
                label: target.label
            });
            await rm(tempPath, { force: true });

            updateMediaFileSize(media.id, statSync(destPath).size);
            addLibraryEntry(requestedBy, media.id, destPath);

            progress({ stage: "completed" });
            return true;
        } catch (error) {
            console.error(`[downloads] Error occured for candidates ${error}`);
            await rm(tempPath, { force: true });
        }
    }

    progress({ stage: "failed", message: "Could not verify a matching download" });
    return false;
}

export async function processDownloadRequestId(requestId: UUID | string): Promise<void> {
    const request = await getRequestById(requestId);
    if (!request) throw new Error("No request with given ID");
    return await processDownloadRequest(request);
}

// entry point: runs the full pipeline for a request and lands it on "completed" or "failed"
export async function processDownloadRequest(request: NafynRequest): Promise<void> {
    if (!request || request.status === "completed" || request.status === "failed") return;

    try {
        await updateRequestStatus(request.id, "searching");
        emitDownloadProgress({ requestId: request.id, stage: "searching", message: "Resolving MusicBrainz data" });

        const client = getMusicBrainzClient();
        const targets = await resolveTargets(client, request.musicbrainzId, request.type);

        if (targets.length === 0) {
            await updateRequestStatus(request.id, "failed");
            emitDownloadProgress({ requestId: request.id, stage: "failed", message: "Nothing found on MusicBrainz for this ID" });
            return;
        }

        // album/EP: one Soulseek search for the whole release, one seller picked for every track so we never
        // end up pulling the same track twice from two different users; the rest of that same search's
        // results stay around as a zero-cost fallback pool before we ever resort to per-track searching
        let primaryResults: SlskSearchResult[] | undefined;
        let poolResults: SlskSearchResult[] | undefined;
        if (request.type === "album" && targets[0].album) {
            emitDownloadProgress({ requestId: request.id, stage: "searching", message: "Searching Soulseek for album" });
            const rawResults = await searchWithFallback([
                `${targets[0].artistName} ${targets[0].album}`,
                `${targets[0].album} ${targets[0].artistName}`
            ]);
            poolResults = rawResults;

            const bestUser = pickBestAlbumUser(rawResults, targets);
            if (bestUser) {
                primaryResults = bestUser.files;
                console.log(`[downloads] Selected Soulseek user "${bestUser.user}" with ${bestUser.matchedTracks}/${targets.length} matching tracks (vs MusicBrainz)`);
                emitDownloadProgress({
                    requestId: request.id,
                    stage: "searching",
                    message: `Selected seller with ${bestUser.matchedTracks}/${targets.length} tracks`
                });
            }
        }

        let anyFailed = false;
        for (const [i, target] of targets.entries()) {
            const ok = await downloadTrack(request.id, request.requestedBy, target, i + 1, targets.length, primaryResults, poolResults);
            if (!ok) anyFailed = true;
        }

        await updateRequestStatus(request.id, anyFailed ? "failed" : "completed");
        emitDownloadProgress({ requestId: request.id, stage: anyFailed ? "failed" : "completed" });
    } catch (err) {
        await updateRequestStatus(request.id, "failed");
        emitDownloadProgress({ requestId: request.id, stage: "failed", message: err instanceof Error ? err.message : "Unknown error" });
    } finally {
        clearDownloadEmitter(request.id);
    }
}
