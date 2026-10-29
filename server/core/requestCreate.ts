// Creating a download request: everything POST /api/v1/request does, as a function, so playlist imports
// (core/imports.ts) go through exactly the same checks without calling the API over HTTP.
import type { UUID } from "crypto";
import { processDownloadRequest, resolveTargets, targetIdentity, type TrackTarget } from "./downloads";
import { findOwnedMediaByIdentity } from "./library";
import { countActiveRequests, createRequest, hasActiveRequest } from "./requests";
import { getPermissionsById } from "./users";
import { notifyRequestCreated } from "./notifications";
import { hasPermission, Permission } from "../entity/Permission";
import type { NafynRequest } from "../entity/NafynRequest";
import type { MediaInfo } from "../entity/media/MediaInfo";
import { getMediaInfo, getMusicBrainzRepository } from "../utils/musicbrainz";
import { isReleased } from "../utils/releaseDate";

export type RequestRefusalReason = "permission" | "not-found" | "unreleased" | "owned" | "already-requested" | "too-many" | "upstream";

export type CreateRequestResult =
    | { ok: true, request: NafynRequest, autoAccepted: boolean }
    | { ok: false, statusCode: number, reason: RequestRefusalReason, message: string, retryAfterSeconds?: number };

// a ceiling on what one account has waiting or in the pipeline at once. The old "30 per 10 minutes" window cut every
// playlist import off at its 31st track; what actually needs bounding is how much one account can have queued.
const DEFAULT_MAX_ACTIVE_REQUESTS = 500;
const TOO_MANY_RETRY_AFTER_SECONDS = 60;

export function maxActiveRequestsPerUser(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.NAFYN_MAX_ACTIVE_REQUESTS_PER_USER);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ACTIVE_REQUESTS;
}

// requests currently being created, keyed by user + MusicBrainz ID. The "already requested" check below reads
// the database, so two clicks landing in the same instant would both pass it before either row exists;
// this closes that gap within the (single) server process.
const inFlight = new Set<string>();

function refuse(statusCode: number, reason: RequestRefusalReason, message: string, retryAfterSeconds?: number): CreateRequestResult {
    return { ok: false, statusCode, reason, message, retryAfterSeconds };
}

/**
 * Creates (and, with the matching AUTOACCEPT permission, starts) a request for `mbId`. `mbId` must already be a
 * validated MusicBrainz ID (see utils/ids.ts). Never throws for a refusal: the reason comes back as a result.
 */
export async function createMediaRequest(userId: string, mbId: string, type: "album" | "track"): Promise<CreateRequestResult> {
    const permissions: number = await getPermissionsById(userId) ?? 0;

    // SECURITY: the REQUEST_ALBUMS / REQUEST_TRACKS permission bits were declared but never checked here,
    // so every authenticated account could queue downloads regardless of what an admin had granted it.
    const required = type == "album" ? Permission.REQUEST_ALBUMS : Permission.REQUEST_TRACKS;
    if (!hasPermission(permissions, required)) {
        return refuse(403, "permission", "Unsufficient permissions");
    }

    if (await countActiveRequests(userId) >= maxActiveRequestsPerUser()) {
        return refuse(429, "too-many", "Too many requests waiting or downloading, try again later", TOO_MANY_RETRY_AFTER_SECONDS);
    }

    // resolve the item exactly as the download pipeline will: the canonical MBID (MusicBrainz redirects a
    // merged-away ID to the surviving entity) and, for an album, the tracklist that would be downloaded.
    // Whether the caller already has it can't be answered without this, so a MusicBrainz outage refuses the
    // request instead of letting a possible duplicate through.
    let info: MediaInfo | null;
    let targets: TrackTarget[];
    try {
        targets = await resolveTargets(getMusicBrainzRepository(), mbId, type);
        info = targets.length > 0 ? await getMediaInfo(mbId, type).catch(() => null) : null;
    } catch (error) {
        // the repository throws on every error response; 400 ("Invalid mbid" - a well-formed UUID MusicBrainz
        // still rejects) and 404 mean the ID points at nothing, anything else is MusicBrainz being unreachable
        if ([400, 404].includes((error as { status?: number }).status ?? 0)) {
            return refuse(404, "not-found", "Nothing found on MusicBrainz for this ID");
        }
        return refuse(502, "upstream", "Could not reach MusicBrainz, try again later");
    }
    if (targets.length === 0) {
        return refuse(404, "not-found", "Nothing found on MusicBrainz for this ID");
    }
    const canonicalId = (type === "track" ? targets[0]!.recordingId : targets[0]!.albumId).toLowerCase();
    const knownIds = [...new Set([mbId.toLowerCase(), canonicalId])];

    // unreleased media can't be requested by anyone - ADMIN included, there's simply nothing to download yet.
    // A failed lookup isn't treated as "unreleased": the pipeline re-checks the date before searching anyway.
    if (info && !isReleased(info.releaseDate)) {
        return refuse(403, "unreleased", "Not released yet");
    }

    const autoAccept: boolean = hasPermission(permissions, type == "album" ? Permission.AUTOACCEPT_ALBUMS : Permission.AUTOACCEPT_TRACKS);

    // one live request per user and item: the button on the album/track page disables itself, but that is a
    // courtesy - a second tab, a script or a double click must not queue the same download again. Keyed by
    // every ID the item goes by, so the old and the new MBID of a merged entity can't each slip one through.
    // Checked and claimed with no await in between, so two concurrent calls can't both get past it.
    const flightKeys = knownIds.map((id) => `${userId}:${id}`);
    if (flightKeys.some((key) => inFlight.has(key))) {
        return refuse(409, "already-requested", "You already requested this");
    }
    flightKeys.forEach((key) => inFlight.add(key));

    let newRequest: NafynRequest;
    try {
        if (await hasActiveRequest(userId, knownIds)) {
            return refuse(409, "already-requested", "You already requested this");
        }

        // nobody requests what they already have: a track in their library - under this MBID or any other
        // name for the same song, see utils/mediaIdentity.ts - or an album whose every track is. An album only
        // partly there stays requestable; the pipeline skips the tracks the caller has and downloads the rest.
        let missingTracks = 0;
        for (const target of targets) {
            if (!(await findOwnedMediaByIdentity(userId, targetIdentity(target)))) missingTracks++;
        }
        if (missingTracks === 0) {
            return refuse(409, "owned", type === "album" ? "Every track of this album is already in your library" : "Already in your library");
        }

        newRequest = await createRequest(canonicalId as UUID, type, userId as UUID, autoAccept ? "searching" : "waiting", info);
    } finally {
        flightKeys.forEach((key) => inFlight.delete(key));
    }

    notifyRequestCreated(newRequest, autoAccept);
    if (autoAccept) {
        processDownloadRequest(newRequest);
    }

    return { ok: true, request: newRequest, autoAccepted: autoAccept };
}
