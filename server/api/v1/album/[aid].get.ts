import type { IRelease, IReleaseGroup } from "musicbrainz-api";
import { getMusicBrainzClient, parseReleaseDate } from "~~/server/utils/musicbrainz";
import type { AlbumDetail } from "~~/server/entity/media/AlbumDetail";
import type { TrackInfo } from "~~/server/entity/media/TrackInfo";
import type { ArtistInfo } from "~~/server/entity/media/ArtistInfo";
import { findLibraryEntry, findMediaByMusicbrainzId } from "~~/server/core/library";
import { hasActiveRequest } from "~~/server/core/requests";

export default defineEventHandler(async (event): Promise<AlbumDetail> => {
    const { sub: userId } = requireAuthToken(event);

    const aid = getRouterParam(event, "aid");
    if (!aid) {
        throw createError({ statusCode: 400, message: "Missing album ID" });
    }

    const client = getMusicBrainzClient();

    const releaseGroup: IReleaseGroup = await client.lookup("release-group", aid, ["artist-credits"]).catch(() => {
        throw createError({ statusCode: 404, message: "No album with ID " + aid });
    });

    const browsed = await client.browse("release", { "release-group": aid }, ["recordings", "artist-credits", "labels", "media", "url-rels"]).catch(() => {
        throw createError({ statusCode: 404, message: "No release found for album " + aid });
    });
    const release: IRelease | undefined = browsed.releases?.[0];
    if (!release) {
        throw createError({ statusCode: 404, message: "No release found for album " + aid });
    }

    const primaryType = releaseGroup["primary-type"]?.toLowerCase();
    const type = primaryType === "album" || primaryType === "ep" ? primaryType : null;
    const releaseDate = parseReleaseDate(releaseGroup["first-release-date"]);
    const label = release["label-info"]?.[0]?.label?.name ?? null;
    const credit = releaseGroup["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit ? { name: credit.name, musicbrainzId: credit.id, description: credit.disambiguation || null, image: null } : "Unknown Artist";

    // a track's own recording can carry an earlier/later first-release-date than the album
    // (staggered singles/rollouts); fall back to the album's date when the recording has none
    const now = Date.now();
    const tracks: TrackInfo[] = [];
    for (const medium of release.media ?? []) {
        for (const track of medium.tracks ?? []) {
            const trackReleaseDate = parseReleaseDate(track.recording?.["first-release-date"]) ?? releaseDate;
            const media = findMediaByMusicbrainzId(track.recording.id);
            const inLibrary = media ? findLibraryEntry(userId, media.id) != null : false;
            const requested = hasActiveRequest(userId, track.recording.id);

            tracks.push({
                id: track.recording.id,
                title: track.title,
                trackNumber: track.position,
                duration: track.length ? Math.round(track.length / 1000) : 0,
                releaseDate: trackReleaseDate,
                released: trackReleaseDate ? trackReleaseDate.getTime() <= now : true,
                inLibrary,
                requested,
                mediaId: media?.id ?? null
            });
        }
    }

    return {
        id: releaseGroup.id,
        releaseId: release.id,
        title: releaseGroup.title,
        artist,
        type,
        coverArt: `https://coverartarchive.org/release-group/${releaseGroup.id}/front-500`,
        releaseDate,
        description: releaseGroup.disambiguation || null,
        label,
        tracks
    };
});
