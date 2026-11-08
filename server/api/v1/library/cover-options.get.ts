// GET /api/v1/library/cover-options?albumId=<release-group MBID> | ?recordingId=<recording MBID> - the alternative
// covers a track or an album can wear.
//   albumId      the release-group's own cover, then the front cover of every release in the group that has one
//                (other countries, reissues, the vinyl, the deluxe...). Used when several tracks are edited as one album.
//   recordingId  the front cover of every release the *recording* is on, whatever release-group they belong to: a
//                single, the album, a compilation, a deluxe all carry the same song and each has its own art. Used
//                when ONE track is edited.
// Only art that exists is offered: a release (or group) without a front cover is never listed.
//
// Nothing here is stored: the client picks one and PATCHes `coverArt` with its `url`, which is a Cover Art Archive
// URL like the one the download pipeline writes.
import type { IRelease, IRecording, RecordingIncludes } from "musicbrainz-api";
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { assertMbid } from "~~/server/utils/ids";
import { getMusicBrainzRepository, TRACK_LOOKUP_INC } from "~~/server/utils/musicbrainz";
import { getSearchDeps } from "~~/server/utils/catalogSearch";
import { MusicBrainzError } from "~~/server/utils/musicbrainzRepository";
import { coverArchiveUrl } from "~~/server/utils/coverUrl";
import { enforceUpstreamLookupLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "List the cover art available for a track (every release of its MusicBrainz recording) or an album (its release-group: the group's own front cover plus the front cover of each release that has one). Entries without a front cover are never listed",
        tags: ["library"],
        operationId: "getCoverOptions",
        parameters: [
            { name: "albumId", in: "query", required: false, description: "MusicBrainz release-group ID (`albumId` of a track). Give this or `recordingId`", schema: { type: "string" } },
            { name: "recordingId", in: "query", required: false, description: "MusicBrainz recording ID (`musicbrainzId` of a track): the covers of every release of that recording. Wins over `albumId`", schema: { type: "string" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["options"],
                            properties: {
                                options: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        required: ["id", "kind", "title", "url"],
                                        properties: {
                                            id: { type: "string", description: "Release or release-group MBID" },
                                            kind: { type: "string", enum: ["release-group", "release"] },
                                            title: { type: "string" },
                                            details: { type: "string", nullable: true, description: "Date, country, format..." },
                                            url: { type: "string", description: "Cover Art Archive URL to store as `coverArt`" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "400": { description: "Neither albumId nor recordingId given, or malformed", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "502": { description: "MusicBrainz could not be reached", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

interface CoverOption {
    id: string,
    kind: "release-group" | "release",
    title: string,
    details: string | null,
    url: string
}

function releaseDetails(release: IRelease): string | null {
    const format = [...new Set((release.media ?? []).map((medium) => medium.format).filter(Boolean))].join(" + ");
    const parts = [release.date, release.country, format, release.disambiguation].filter((part) => !!part);
    return parts.length > 0 ? parts.join(" · ") : null;
}

// the archive says "front: true" for a cover it later took down (`darkened`); that image no longer serves
function hasFrontCover(release: IRelease): boolean {
    const archive = release["cover-art-archive"];
    return archive?.front === true && archive.darkened !== true;
}

const MAX_RECORDING_RELEASES = 60;
const CHECK_CONCURRENCY = 8;

/** The releases of a recording that really have a front cover. A recording lookup may carry no archive summary, so the archive is asked. */
async function releasesWithFront(releases: IRelease[]): Promise<IRelease[]> {
    const { cover } = getSearchDeps();
    const candidates = releases.slice(0, MAX_RECORDING_RELEASES);
    const keep: boolean[] = new Array(candidates.length).fill(false);
    let cursor = 0;
    const worker = async () => {
        for (let index = cursor++; index < candidates.length; index = cursor++) {
            const release = candidates[index]!;
            const known = release["cover-art-archive"];
            if (known) {
                keep[index] = hasFrontCover(release);
            } else {
                // release level only: the group's cover is some *other* release's art, not this one's
                keep[index] = await cover.hasFront({ releaseId: release.id, releaseGroupId: null });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, candidates.length) }, worker));
    return candidates.filter((_, index) => keep[index]);
}

function upstreamError(): never {
    throw createError({ statusCode: 502, statusMessage: "MusicBrainz is unavailable, try again in a moment" });
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    const query = getQuery(event);
    // SECURITY: reaches MusicBrainz and the archive; the id is validated as an MBID before any URL is built
    const recordingId = query.recordingId ? assertMbid(query.recordingId, "recording ID") : null;
    const albumId = recordingId ? null : assertMbid(query.albumId, "album ID");
    enforceUpstreamLookupLimit(event, userId);

    if (recordingId) {
        let recording: IRecording;
        try {
            // the include list every recording lookup shares, so this is usually a cache hit
            recording = await getMusicBrainzRepository().lookup("recording", recordingId, TRACK_LOOKUP_INC as RecordingIncludes[]);
        } catch (error) {
            if (error instanceof MusicBrainzError && (error.status === 400 || error.status === 404)) return { options: [] as CoverOption[] };
            upstreamError();
        }
        const withFront = await releasesWithFront(recording.releases ?? []);
        const options: CoverOption[] = withFront.map((release) => ({
            id: release.id,
            kind: "release",
            title: release.title,
            details: releaseDetails(release),
            url: coverArchiveUrl("release", release.id, 500)
        }));
        return { options };
    }

    let releases: IRelease[];
    try {
        const browsed = await getMusicBrainzRepository().browse("release", { "release-group": albumId! }, ["recordings", "artist-credits", "labels", "media", "url-rels", "isrcs"]);
        releases = browsed.releases ?? [];
    } catch (error) {
        if (error instanceof MusicBrainzError && (error.status === 400 || error.status === 404)) return { options: [] };
        upstreamError();
    }

    const withFront = releases.filter(hasFrontCover);
    if (withFront.length === 0) return { options: [] as CoverOption[] };

    const options: CoverOption[] = [{
        id: albumId!,
        kind: "release-group",
        title: releases[0]?.["release-group"]?.title ?? withFront[0]!.title,
        details: null,
        url: coverArchiveUrl("release-group", albumId!, 500)
    }];

    for (const release of withFront) {
        options.push({
            id: release.id,
            kind: "release",
            title: release.title,
            details: releaseDetails(release),
            url: coverArchiveUrl("release", release.id, 500)
        });
    }

    return { options };
});
