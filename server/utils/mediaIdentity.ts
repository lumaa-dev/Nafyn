// "is this the same song?" - the identity of a recording, independent of which MusicBrainz ID happens to name it.
//
// A raw MBID comparison is not enough to stop someone requesting a song they already have:
//   - MusicBrainz merges duplicate recordings. The merged-away MBID keeps resolving (a lookup redirects to the
//     surviving one), so a file downloaded under one ID can be requested again under the other.
//   - MusicBrainz also holds plenty of unmerged duplicates: the same master entered once per release, each
//     with its own MBID but the same ISRC.
//   - Manually imported files have no MusicBrainz ID at all.
// So a recording is matched, strongest signal first, by MBID (its own plus every alias recorded for a media
// row), then by ISRC, then - for the requester's own library only - by title + artist + duration.
import { foldDiacritics } from "./soulseek";

export interface RecordingIdentity {
    // every MBID known to name this recording: the canonical one MusicBrainz returned, plus the one asked for
    mbids: string[],
    isrcs: string[],
    title: string,
    artistMbid: string | null,
    artistName: string,
    // seconds, 0 when unknown
    duration: number
}

// two durations further apart than this are two different recordings (a live take, an edit, an extended
// mix), even under the same title and artist; the same recording on two releases is typically within 1-2 s
export const SAME_SONG_DURATION_TOLERANCE_SECONDS = 3;

// placeholder written for a credit-less recording (see resolveTargets in core/downloads.ts) - never an identity
const UNKNOWN_ARTIST_MBID = "unknown-artist";

export function normalizeForMatch(text: string): string {
    return foldDiacritics(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function normalizeIsrc(isrc: string): string {
    return isrc.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function usableArtistMbid(mbid: string | null | undefined): string | null {
    return mbid && mbid !== UNKNOWN_ARTIST_MBID ? mbid : null;
}

export function buildIdentity(fields: {
    mbids: (string | null | undefined)[],
    isrcs?: (string | null | undefined)[],
    title: string,
    artistMbid?: string | null,
    artistName: string,
    duration?: number | null
}): RecordingIdentity {
    const mbids = [...new Set(fields.mbids.filter((id): id is string => !!id).map((id) => id.toLowerCase()))];
    const isrcs = [...new Set((fields.isrcs ?? []).filter((isrc): isrc is string => !!isrc).map(normalizeIsrc).filter(Boolean))];
    return {
        mbids,
        isrcs,
        title: fields.title,
        artistMbid: usableArtistMbid(fields.artistMbid),
        artistName: fields.artistName,
        duration: fields.duration && fields.duration > 0 ? Math.round(fields.duration) : 0
    };
}

// the weakest match: same normalized title, same artist (by MBID, or by name - a manual import has no artist
// MBID, and artists get merged on MusicBrainz too), and durations that agree when both are known
export function isSameSongByMetadata(
    identity: RecordingIdentity,
    candidate: { title: string, artistName: string, artistMbid: string | null, duration: number }
): boolean {
    const title = normalizeForMatch(identity.title);
    if (!title || title !== normalizeForMatch(candidate.title)) return false;

    const candidateArtistMbid = usableArtistMbid(candidate.artistMbid);
    const sameArtist = (identity.artistMbid !== null && identity.artistMbid === candidateArtistMbid)
        || (normalizeForMatch(identity.artistName) !== "" && normalizeForMatch(identity.artistName) === normalizeForMatch(candidate.artistName));
    if (!sameArtist) return false;

    if (identity.duration > 0 && candidate.duration > 0) {
        return Math.abs(identity.duration - candidate.duration) <= SAME_SONG_DURATION_TOLERANCE_SECONDS;
    }
    return true;
}
