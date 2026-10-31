// GET /api/v1/library/cover-options?albumId=<release-group MBID> - the alternative covers of an album: the
// release-group's own cover, then the front cover of every release in the group that has one (other countries,
// reissues, the vinyl, the deluxe...). The edit modal offers them next to "upload your own".
//
// Nothing here is stored: the client picks one and PATCHes `coverArt` with its `url`, which is a Cover Art Archive
// URL like the one the download pipeline writes.
import type { IRelease } from "musicbrainz-api";
import { requireAuthToken } from "~~/server/utils/requireAuth";
import { assertMbid } from "~~/server/utils/ids";
import { getMusicBrainzRepository } from "~~/server/utils/musicbrainz";
import { MusicBrainzError } from "~~/server/utils/musicbrainzRepository";
import { coverArchiveUrl } from "~~/server/utils/coverUrl";
import { enforceUpstreamLookupLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "List the cover art available for an album, from its MusicBrainz release-group: the group's own front cover plus the front cover of each release that has one",
        tags: ["library"],
        operationId: "getCoverOptions",
        parameters: [
            { name: "albumId", in: "query", required: true, description: "MusicBrainz release-group ID (`albumId` of a track)", schema: { type: "string" } }
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
            "400": { description: "Missing or malformed albumId", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
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

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    // SECURITY: reaches MusicBrainz and the archive; the id is validated as an MBID before any URL is built
    const albumId = assertMbid(getQuery(event).albumId, "album ID");
    enforceUpstreamLookupLimit(event, userId);

    let releases: IRelease[];
    try {
        const browsed = await getMusicBrainzRepository().browse("release", { "release-group": albumId }, ["recordings", "artist-credits", "labels", "media", "url-rels", "isrcs"]);
        releases = browsed.releases ?? [];
    } catch (error) {
        if (error instanceof MusicBrainzError && (error.status === 400 || error.status === 404)) return { options: [] };
        throw createError({ statusCode: 502, statusMessage: "MusicBrainz is unavailable, try again in a moment" });
    }

    const withFront = releases.filter((release) => release["cover-art-archive"]?.front);
    if (withFront.length === 0) return { options: [] as CoverOption[] };

    const options: CoverOption[] = [{
        id: albumId,
        kind: "release-group",
        title: releases[0]?.["release-group"]?.title ?? withFront[0]!.title,
        details: null,
        url: coverArchiveUrl("release-group", albumId, 500)
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
