// all the Soulseek downloads are handled here
//
// pipeline:
//   1. Search song(s) with title, artist, album info
//   2. Match data with MusicBrainz
//   3. Check if song is already downloaded by anyone (if found, just grant the requesting user access to that file)
//   4. Get song(s) through Soulseek API
//   5. Verify song(s) fingerprint with AcoustID
//   6. Edit audio file metadata with song info from MusicBrainz (fetched in step 2)
//   7. Write the song once under music/{album}/{track title}.ext and grant the requesting user access
//   8. Set request status to "completed"
//
// security/anonymity notes:
//   - downloads go through a self-hosted slskd instance (see utils/soulseek.ts); what it shares back to the
//     Soulseek network is entirely its own configuration, outside this app's control
//   - peer-supplied filenames are never trusted for anything beyond a whitelisted extension; every file we
//     write uses our own random/UUID-derived name, so a malicious peer can't path-traverse or spoof identity
//     through its filename
//   - a download is rejected when AcoustID confidently names a *different* song for its audio, or when it doesn't
//     match the requested MusicBrainz recording AND its measured duration is off by more than a few seconds; a
//     missing AcoustID entry alone (it frequently lacks a given recording) is not enough to gate on. The
//     fingerprint and duration are always regenerated from the file itself, never read from anything stored.
//   - a rejected or failed download leaves nothing behind: the temp copy, the file in slskd's downloads folder,
//     its transfer record and the emptied folders are all removed (see utils/soulseek.ts)
//   - true network-level anonymity (hiding your IP from Soulseek peers) isn't something the protocol supports;
//     use a dedicated/throwaway Soulseek account and, if you need IP-level anonymity too, run slskd itself
//     behind a VPN at the infrastructure level

import { randomUUID, UUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { rm } from "node:fs/promises";
import { statSync } from "node:fs";
import type { IRecording, IRelease, IReleaseGroup, RecordingIncludes } from "musicbrainz-api";
import type { SlskSearchResult } from "../utils/soulseek";
import { getMusicBrainzRepository, getAppleMusicTrackID } from "../utils/musicbrainz";
import { MusicBrainzError, type MusicBrainzRepository } from "../utils/musicbrainzRepository";
import { pickCanonicalRelease, pickReleaseForGroup } from "../utils/release";
import { searchSoulseek, downloadFromSoulseek, foldDiacritics } from "../utils/soulseek";
import { verifyRecordingMatch } from "../utils/fingerprint";
import { parseCoverArtUrl, warmCover } from "../utils/coverArtCache";
import { tagAudioFile } from "../utils/audioTag";
import { getRequestById, updateRequestStatus } from "./requests";
import {
    findMediaByIdentity,
    findOwnedMediaByIdentity,
    findAnyLibraryEntryForMedia,
    insertMedia,
    addLibraryEntry,
    addMediaIdentifiers,
    shareMediaWithUser,
    libraryFilePath,
    updateMediaFileSize,
    deleteOrphanMediaRow,
    type LibraryEntry,
    type MediaRow
} from "./library";
import { buildIdentity, type RecordingIdentity } from "../utils/mediaIdentity";
import { emitDownloadProgress, clearDownloadEmitter } from "../utils/downloadEvents";
import { isReleased } from "../utils/releaseDate";
import { notifyRequestFinished } from "./notifications";
import { acquireDownloadSlot } from "./downloadQueue";
import { NafynRequest } from "../entity/NafynRequest";
import { ensureDir } from "../utils/ensureDir";

const TMP_DIR = join(process.cwd(), ".data", "tmp");
const ALLOWED_EXTENSIONS = [".mp3", ".flac", ".ogg", ".wav"];
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_CANDIDATES_PER_TRACK = 5;
const MAX_DURATION_DELTA_SECONDS = 5;

// filenames carrying one of these words are a different version of the track (same duration as the original
// is common for instrumentals/acapellas), so duration alone can't be trusted to wave a mismatched fingerprint
// through - only exclude when the requested title itself isn't asking for that version
const EXCLUDED_VERSION_KEYWORDS = ["instrumental", "acapella", "a cappella", "karaoke", "backing track", "no vocal", "no vocals"];

export interface TrackTarget {
    recordingId: string,
    // other MBIDs naming this recording - the one a track request carried, when MusicBrainz redirected it
    aliases: string[],
    isrcs: string[],
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
    amId: string | null,
    discNumber: number
}

function parseReleaseDate(date: string | undefined): Date | null {
    if (!date) return null;
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function targetIdentity(target: TrackTarget): RecordingIdentity {
    return buildIdentity({
        mbids: [target.recordingId, ...target.aliases],
        isrcs: target.isrcs,
        title: target.title,
        artistMbid: target.artistMbid,
        artistName: target.artistName,
        duration: target.duration
    });
}

// the repository throws on every error response: an unknown ID (404, or the 400 MusicBrainz gives a well-formed
// UUID it rejects) is "nothing there" -> null, anything else (busy, circuit open, network) stays a throw
async function lookupOrNull<T>(lookup: Promise<T>): Promise<T | null> {
    try {
        return await lookup;
    } catch (error) {
        if (error instanceof MusicBrainzError && (error.status === 404 || error.status === 400)) return null;
        throw error;
    }
}

// step 2: resolve the request's MusicBrainz ID into one (track) or many (album) concrete recordings to fetch.
// Also what POST /api/v1/request checks against the caller's library before a request is even created.
export async function resolveTargets(client: MusicBrainzRepository, musicbrainzId: string, type: "album" | "track"): Promise<TrackTarget[]> {
    if (type === "track") {
        // `release-groups` is a valid recording include on MusicBrainz but missing from musicbrainz-api's types
        const recording: IRecording | null = await lookupOrNull(client.lookup("recording", musicbrainzId, ["artist-credits", "releases", "release-groups", "media", "url-rels", "isrcs"] as RecordingIncludes[]));
        if (!recording) return [];
        // same picker as GET /api/v1/track/{tid} (see utils/release.ts): the album/label/cover written into
        // the file's tags must be the one the user was looking at when they requested the track
        const release = pickCanonicalRelease(recording.releases);
        const credit = recording["artist-credit"]?.[0]?.artist;
        // this recording's position within the picked release's tracklist, when the release carries one
        const trackNumber = release?.media
            ?.flatMap((medium) => medium.tracks ?? [])
            .find((track) => track.recording?.id === recording.id)?.position ?? null;

        // albumId must be the release-*group* MBID (not the release's own ID) so the library's
        // "album" grouping links back to a valid /api/v1/album/{aid} target
        return [{
            recordingId: recording.id,
            // a merged-away MBID resolves to the surviving recording, whose id differs from the one asked for
            aliases: recording.id.toLowerCase() === musicbrainzId.toLowerCase() ? [] : [musicbrainzId],
            isrcs: recording.isrcs ?? [],
            title: recording.title,
            artistName: credit?.name ?? "Unknown Artist",
            artistMbid: credit?.id ?? "unknown-artist",
            album: release?.title ?? null,
            albumId: release?.["release-group"]?.id ?? "unknown-album",
            albumType: null,
            trackNumber,
            releaseDate: parseReleaseDate(recording["first-release-date"]),
            duration: recording.length ? Math.round(recording.length / 1000) : 0,
            label: null,
            coverArt: release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
            amId: getAppleMusicTrackID(recording, release) ?? null,
            discNumber: 1
        }];
    }

    const releaseGroup: IReleaseGroup | null = await lookupOrNull(client.lookup("release-group", musicbrainzId, ["artist-credits"]));
    if (!releaseGroup) return [];
    // browsed by the id the lookup returned: a merged-away release-group MBID still resolves on lookup, but
    // has no releases of its own to browse
    const browsed = await client.browse("release", { "release-group": releaseGroup.id }, ["recordings", "artist-credits", "labels", "media", "isrcs"]);
    const browseError = (browsed as { error?: unknown }).error;
    if (typeof browseError === "string") throw new Error(`MusicBrainz: ${browseError}`);
    // same picker as GET /api/v1/album/{aid}, so the tracks downloaded here are exactly the tracks the
    // album page listed - the official standard edition, not a deluxe whose extra tracks nobody shares
    const release: IRelease | undefined = pickReleaseForGroup(releaseGroup, browsed.releases);
    if (!release) return [];

    const primaryType = releaseGroup["primary-type"]?.toLowerCase();
    const albumType = primaryType === "album" || primaryType === "ep" ? primaryType : null;
    const label = release["label-info"]?.[0]?.label?.name ?? null;
    const releaseArtist = releaseGroup["artist-credit"]?.[0]?.artist;
    const releaseDate = parseReleaseDate(releaseGroup["first-release-date"]);
    const coverArt = `https://coverartarchive.org/release-group/${releaseGroup.id}/front-250`;
    const amId = getAppleMusicTrackID(undefined, release) ?? null;

    const targets: TrackTarget[] = [];
    for (const [mediumIndex, medium] of (release.media ?? []).entries()) {
        for (const track of medium.tracks ?? []) {
            const trackArtist = track["artist-credit"]?.[0]?.artist ?? releaseArtist;
            targets.push({
                recordingId: track.recording.id,
                aliases: [],
                isrcs: track.recording.isrcs ?? [],
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
                amId,
                discNumber: medium.position ?? mediumIndex + 1
            });
        }
    }
    // disc by disc, track by track: the order the downloads run in and the order the library ends up in
    return targets.sort((a, b) => (a.discNumber - b.discNumber) || ((a.trackNumber ?? 0) - (b.trackNumber ?? 0)));
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

// must diacritic-fold the same way soulseek.ts's foldDiacritics does before collapsing non-ASCII runs to
// spaces, or accented titles ("Dîner" -> "d ner") never substring-match their unaccented filenames ("diner")
function normalize(s: string): string {
    return foldDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

// true when the user already has this song in their library. A match by MBID/ISRC also records the target's
// identifiers on that row, so the next lookup under this name is a direct hit.
async function alreadyOwned(userId: string, identity: RecordingIdentity): Promise<boolean> {
    const owned = await findOwnedMediaByIdentity(userId, identity);
    if (!owned) return false;
    // never from a title match: that would let a later *strong* lookup hand this file to other users as
    // "the same recording", which is only a guess (and may be someone's manual upload)
    if (owned.strength !== "metadata") await addMediaIdentifiers(owned.media.id, identity);
    return true;
}

// grants the user another user's existing copy of this recording (matched by MBID or ISRC), if there is one
async function shareExistingCopy(userId: string, identity: RecordingIdentity): Promise<boolean> {
    for (const media of await findMediaByIdentity(identity)) {
        const sourceEntry = await findAnyLibraryEntryForMedia(media.id);
        if (!sourceEntry) continue;
        await shareMediaWithUser(userId, media, sourceEntry.filePath);
        await addMediaIdentifiers(media.id, identity);
        return true;
    }
    return false;
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
    // a single track finishing or failing is never the end of the request (finish() in processDownloadRequest
    // emits that): sent as "completed"/"failed" it would freeze the client's live view mid-album, so it goes
    // out as "processing" with the track's own outcome in `trackResult`
    const progress = (fields: Partial<Parameters<typeof emitDownloadProgress>[0]>) => {
        const trackResult = fields.stage === "completed" || fields.stage === "failed" ? fields.stage : undefined;
        emitDownloadProgress({
            requestId, trackTitle: target.title, trackIndex, trackCount, stage: "searching", ...fields,
            ...(trackResult ? { stage: "processing" as const, trackResult } : {})
        });
    };
    // step 3: the requester already has this song - under this MBID or any other name for it (see
    // utils/mediaIdentity.ts) - or someone else downloaded it already. Never a second copy either way.
    const identity = targetIdentity(target);
    if (await alreadyOwned(requestedBy, identity)) {
        progress({ stage: "completed", message: "Already in library" });
        return true;
    }
    if (await shareExistingCopy(requestedBy, identity)) {
        progress({ stage: "completed", message: "Granted access to existing library entry" });
        return true;
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
        const rawResults = await searchWithFallback([
            `${target.artistName} ${target.title}`,
            `${target.title} ${target.artistName}`,
            `*${target.artistName.substring(1, target.artistName.length)} ${target.title}`,
            `${target.title} *${target.artistName.substring(1, target.artistName.length)}`,
        ]);
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
        // set only when *this* candidate attempt inserts a brand-new media row, so a failure past this point
        // can roll it back instead of leaving an orphan for the next candidate attempt to duplicate again
        let insertedMediaId: string | null = null;
        // the reserved library path (see libraryFilePath), cleared again once a library entry owns the file
        let destPath: string | null = null;

        try {
            await downloadFromSoulseek(candidate, tempPath, (dl) => {
                progress({
                    stage: "downloading",
                    bytesDownloaded: dl.bytesDownloaded,
                    totalBytes: dl.totalBytes,
                    speedBytesPerSec: dl.speedBytesPerSec,
                    etaSeconds: dl.etaSeconds,
                    message: "Downloading"
                });
            });

            // step 5: verify fingerprint
            await updateRequestStatus(requestId, "processing");
            progress({ stage: "processing", message: "Verifying fingerprint" });

            // The file is judged on what it *is*, never on anything stored: verifyRecordingMatch regenerates the
            // fingerprint and measures the duration from this very file, asks AcoustID, and scores every
            // candidate it returns (score threshold, duration tolerance, ranking, merged/alias MBIDs, same
            // title + artist under another recording). AcoustID still lacks plenty of correct recordings, so "no
            // candidate" alone is not proof of a wrong file - but a confident candidate that is a *different* song,
            // or a measured length far from what MusicBrainz says, is. Instrumental/acapella/karaoke versions
            // share the original's runtime, which is why they are filtered out of the candidate list before we
            // get here (see isExcludedVersion).
            const check = await verifyRecordingMatch(tempPath, {
                recordingId: target.recordingId,
                aliases: target.aliases,
                title: target.title,
                artistName: target.artistName,
                duration: target.duration
            });

            // the measured length against MusicBrainz's; null when MusicBrainz has none, which says nothing
            // either way (and must never be papered over with the measured value, or every unmatched file
            // would look like a perfect duration match)
            const durationDelta = target.duration > 0 && check.duration > 0 ? Math.abs(check.duration - target.duration) : null;
            const label = check.fingerprint.slice(0, 12);

            if (!check.verified) {
                // AcoustID couldn't be reached at all (network/DNS) - that's not evidence the file is wrong,
                // so don't fail the request over it, just accept the download unverified
                console.log(`[downloads] ${label} could not be verified against AcoustID (unreachable), accepting anyway`);
            } else if (check.matched) {
                console.log(`[downloads] ${label} matched (${check.via}, score ${check.bestScore.toFixed(2)})`);
            } else if (check.confidentOther) {
                console.log(`[downloads] ${label} rejected: AcoustID is ${check.confidentOther.score.toFixed(2)} sure it is "${check.confidentOther.title}" by ${check.confidentOther.artist}`);
                await rm(tempPath, { force: true });
                continue;
            } else if (durationDelta !== null && durationDelta > MAX_DURATION_DELTA_SECONDS) {
                console.log(`[downloads] ${label} rejected: not matched and duration off by ${durationDelta.toFixed(1)}s`);
                await rm(tempPath, { force: true });
                continue;
            } else {
                console.log(`[downloads] ${label} not matched by AcoustID, no contradicting candidate and duration ${durationDelta === null ? "unknown to MusicBrainz" : `within ${durationDelta.toFixed(1)}s`}, accepting`);
            }

            // MusicBrainz has no duration for every recording; the length measured from the downloaded audio is
            // then the only real one to store
            if (target.duration <= 0 && check.duration > 0) target.duration = Math.round(check.duration);

            // step 6+7: tag with MusicBrainz metadata, move into the requesting user's library
            // re-check here (not just once before the candidate loop): an earlier candidate in this same
            // loop, or a concurrent request for the same recording (this user's album request and track
            // request overlapping, say), may have landed it since we last checked
            if (await alreadyOwned(requestedBy, identity)) {
                await rm(tempPath, { force: true });
                progress({ stage: "completed", message: "Already in library" });
                return true;
            }
            if (await shareExistingCopy(requestedBy, identity)) {
                // someone beat us to it while we were downloading/verifying this candidate - share their
                // existing file instead of tagging our own copy into a second physical file for the same track
                await rm(tempPath, { force: true });
                progress({ stage: "completed", message: "Granted access to existing library entry" });
                return true;
            }
            // a row with no owner yet (the other in-flight attempt hasn't reached addLibraryEntry) - finish
            // tagging this download against that already-inserted row instead of inserting a second one
            const reusableMedia: MediaRow | null = (await findMediaByIdentity(identity))[0] ?? null;

            const media = reusableMedia ?? await insertMedia({
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
                // informational only: never read back to verify anything (see utils/fingerprint.ts)
                fingerprint: check.fingerprint,
                amId: target.amId,
                fileSize: null,
                trackNumber: target.trackNumber
            });
            if (!reusableMedia) insertedMediaId = media.id;
            // have the cover on disk before the first page that shows it asks (the archive is slow when cold)
            const cover = target.coverArt ? parseCoverArtUrl(target.coverArt) : null;
            if (cover) {
                warmCover(cover.kind, cover.id, 250);
                warmCover(cover.kind, cover.id, 500);
            }
            // right away, so a concurrent attempt under another MBID/ISRC for the same song finds this row too
            await addMediaIdentifiers(media.id, identity);

            console.log(`[downloads] Musicbrainz'd "${target.title}"`);

            destPath = libraryFilePath(target.album, target.artistName, target.title, extension);
            await ensureDir(dirname(destPath));
            await tagAudioFile(tempPath, destPath, {
                title: target.title,
                artist: target.artistName,
                album: target.album,
                trackNumber: target.trackNumber,
                date: target.releaseDate,
                label: target.label
            });
            await rm(tempPath, { force: true });

            await updateMediaFileSize(media.id, statSync(destPath).size);
            const entry: LibraryEntry = await addLibraryEntry(requestedBy, media.id, destPath);
            // the requester already held this row (a race the checks above can't fully close): keep their
            // file, and drop ours rather than leave an unreferenced second copy in music/
            if (entry.filePath !== destPath) await rm(destPath, { force: true });
            destPath = null;

            progress({ stage: "completed" });
            return true;
        } catch (error) {
            console.error(`[downloads] Error occured for candidates ${error}`);
            // never let cleanup throw out of the catch itself and fail the whole request over a leftover temp file
            await rm(tempPath, { force: true }).catch(() => {});
            // nothing owns the reserved/partially written library file yet, so it would otherwise linger
            if (destPath) await rm(destPath, { force: true }).catch(() => {});
            if (insertedMediaId) {
                // this attempt's own insertMedia never reached addLibraryEntry - remove it so the next
                // candidate attempt doesn't insert yet another row for the same recording (the orphaned,
                // unowned "duplicate media row" bug)
                await deleteOrphanMediaRow(insertedMediaId).catch(() => {});
            }
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
    if (!request || request.status === "completed" || request.status === "failed" || request.status === "denied") return;

    // instance-wide cap on requests in the pipeline; past it the request waits here, still "searching"
    const release = await acquireDownloadSlot(request.id, (position) => {
        emitDownloadProgress({ requestId: request.id, stage: "searching", message: `Queued (position ${position})` });
    });
    try {
        await runDownloadRequest(request);
    } finally {
        release();
    }
}

async function runDownloadRequest(request: NafynRequest): Promise<void> {

    // the one way a request leaves the pipeline: status, live progress and notifications all agree on it
    const finish = async (outcome: "completed" | "failed", message?: string) => {
        await updateRequestStatus(request.id, outcome);
        emitDownloadProgress({ requestId: request.id, stage: outcome, message });
        notifyRequestFinished(request.id, outcome, outcome === "failed" ? message ?? null : null);
    };

    if (!useRuntimeConfig().acoustidApiKey) {
        await finish("failed", "AcoustID API key is not configured");
        return;
    }

    try {
        await updateRequestStatus(request.id, "searching");
        emitDownloadProgress({ requestId: request.id, stage: "searching", message: "Resolving MusicBrainz data" });

        const client = getMusicBrainzRepository();
        const targets = await resolveTargets(client, request.musicbrainzId, request.type);

        if (targets.length === 0) {
            await finish("failed", "Nothing found on MusicBrainz for this ID");
            return;
        }

        // requests are refused for unreleased media up front (POST /api/v1/request), but one queued before
        // that check existed, or whose release date moved later since, must not go to Soulseek either
        if (!isReleased(targets[0]!.releaseDate)) {
            await finish("failed", "Not released yet");
            return;
        }

        // `getRequestById` resolves `requestedBy` into a full NafynUser whenever that account still exists
        // (so the MANAGE_REQUESTS approval path, which goes through processDownloadRequestId, hands us an
        // object here while the auto-accept path hands us a bare UUID). Normalize before it is used as a
        // user id, or the resulting library_entries row is granted to the string "[object Object]" - i.e.
        // to nobody, leaving the file unreachable by the person who requested it.
        const requestedById = typeof request.requestedBy === "string" ? request.requestedBy : request.requestedBy?.id;
        if (!requestedById) {
            await finish("failed", "Request has no valid requester");
            return;
        }

        // tracks the requester already has (under any name, see utils/mediaIdentity.ts) are never searched for:
        // a request for something fully owned completes without touching Soulseek, and the seller for an
        // album is picked on the tracks actually missing
        const missingTargets: TrackTarget[] = [];
        for (const target of targets) {
            if (!(await findOwnedMediaByIdentity(requestedById, targetIdentity(target)))) missingTargets.push(target);
        }
        if (missingTargets.length === 0) {
            await finish("completed", "Already in library");
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
                `${targets[0].album} ${targets[0].artistName}`,
                `*${targets[0]?.artistName.substring(1, targets[0]?.artistName.length)} ${targets[0].album}`,
                `${targets[0].album} *${targets[0]?.artistName.substring(1, targets[0]?.artistName.length)}`
            ]);
            poolResults = rawResults;

            const bestUser = pickBestAlbumUser(rawResults, missingTargets);
            if (bestUser) {
                primaryResults = bestUser.files;
                console.log(`[downloads] Selected Soulseek user "${bestUser.user}" with ${bestUser.matchedTracks}/${missingTargets.length} missing tracks (vs MusicBrainz)`);
                emitDownloadProgress({
                    requestId: request.id,
                    stage: "searching",
                    message: `Selected seller with ${bestUser.matchedTracks}/${missingTargets.length} tracks`
                });
            }
        }

        // strictly in track order, and a track that did not land gets one more go (fresh per-track search,
        // no preferred seller) before the next one starts, so a skipped track can't slip through unnoticed
        for (const [i, target] of targets.entries()) {
            let ok = await downloadTrack(request.id, requestedById, target, i + 1, targets.length, primaryResults, poolResults);
            if (!ok) ok = await downloadTrack(request.id, requestedById, target, i + 1, targets.length);
        }

        // the request is only complete when the requester really owns every track of it (by the same
        // identity match that let a track be skipped as "already in library")
        const missing: string[] = [];
        for (const [i, target] of targets.entries()) {
            if (!(await findOwnedMediaByIdentity(requestedById, targetIdentity(target)))) {
                missing.push(`${target.trackNumber ?? i + 1}. ${target.title}`);
            }
        }

        if (missing.length > 0) {
            await finish("failed", `${missing.length} of ${targets.length} tracks could not be downloaded: ${missing.join(", ")}`);
        } else {
            await finish("completed");
        }
    } catch (err) {
        await finish("failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
        clearDownloadEmitter(request.id);
    }
}
