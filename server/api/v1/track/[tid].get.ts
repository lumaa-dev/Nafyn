// [tid].get.ts
import { getMusicBrainzClient, parseReleaseDate } from "~~/server/utils/musicbrainz";
import type { MediaInfo } from "~~/server/entity/media/MediaInfo";
import type { ArtistInfo } from "~~/server/entity/media/ArtistInfo";
import { IRecording } from "musicbrainz-api";

export default defineEventHandler(async (event) => {
    requireAuthToken(event);

    const tid = getRouterParam(event, "tid");
    if (!tid) {
        throw createError({ statusCode: 400, statusMessage: "Missing track ID" });
    }

    const client = getMusicBrainzClient();

    const recording: IRecording = await client.lookup("recording", tid, ["artist-credits", "releases", "release-groups"]).catch(() => {
        throw createError({ statusCode: 404, statusMessage: "No track with ID " + tid });
    });

    const release = recording.releases?.[0];
    const albumMbid = release?.["release-group"]?.id ?? null;
    const credit = recording["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit ? { name: credit.name, musicbrainzId: credit.id, description: null, image: null } : "Unknown Artist";

    const amId: string | undefined = getAppleMusicTrackID(recording, release);

    const media: MediaInfo = {
        id: recording.id,
        title: recording.title,
        artist,
        album: release ? { id: albumMbid, type: null, title: release.title } : null,
        type: "track",
        coverArt: release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
        releaseDate: parseReleaseDate(recording["first-release-date"]),
        inLibrary: null,
        duration: recording.length ? Math.round(recording.length / 1000) : 0,
        label: null,
        relations: {
            amId
        }
    };

    return { ...media, albumMbid };
});