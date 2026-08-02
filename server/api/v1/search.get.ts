import type { IArtist, IArtistCredit, IRecording, IReleaseGroup } from "musicbrainz-api";
import { getMusicBrainzClient } from "../../utils/musicbrainz";
import { requireAuthToken } from "../../utils/requireAuth";
import type { MediaInfo } from "../../entity/media/MediaInfo";
import type { ArtistInfo } from "../../entity/media/ArtistInfo";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type Filter = "album" | "track" | "artist" | "all";

function toArtistInfo(artist: IArtist): ArtistInfo {
    return {
        name: artist.name,
        musicbrainzId: artist.id,
        description: artist.disambiguation || null,
        image: null
    };
}

function creditToArtistInfo(credit: IArtistCredit[] | undefined): ArtistInfo {
    const artist = credit?.[0]?.artist;
    return artist ? toArtistInfo(artist) : { name: "Unknown Artist", musicbrainzId: "", description: null, image: null };
}

function parseReleaseDate(date: string | undefined): Date | null {
    if (!date) return null;
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function releaseGroupToMediaInfo(releaseGroup: IReleaseGroup): MediaInfo {
    const primaryType = releaseGroup["primary-type"]?.toLowerCase();

    return {
        id: releaseGroup.id,
        title: releaseGroup.title,
        artist: creditToArtistInfo(releaseGroup["artist-credit"]),
        album: null,
        type: primaryType === "album" || primaryType === "ep" ? primaryType : null,
        coverArt: `https://coverartarchive.org/release-group/${releaseGroup.id}/front-250`,
        releaseDate: parseReleaseDate(releaseGroup["first-release-date"]),
        inLibrary: false,
        duration: 0,
        label: null
    };
}

function recordingToMediaInfo(recording: IRecording): MediaInfo {
    const release = recording.releases?.[0];

    return {
        id: recording.id,
        title: recording.title,
        artist: creditToArtistInfo(recording["artist-credit"]),
        album: {
            title: release?.title ?? null,
            id: release?.id ?? null,
            type: null
        },
        type: "track",
        coverArt: release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
        releaseDate: parseReleaseDate(recording["first-release-date"]),
        inLibrary: false,
        duration: recording.length ? Math.round(recording.length / 1000) : 0,
        label: null
    };
}

export default defineEventHandler(async (event) => {
    requireAuthToken(event);

    const query = getQuery(event);
    const q = typeof query?.q === "string" ? query.q.trim() : "";
    const filter: Filter = query?.filter === "album" || query?.filter === "track" || query?.filter === "artist" ? query.filter : "all";

    if (!q) {
        throw createError({ statusCode: 400, statusMessage: "Missing search query `q`" });
    }

    const limit = Math.min(Number(query?.limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(Number(query?.offset) || 0, 0);

    const client = getMusicBrainzClient();

    const [albums, tracks, artists] = await Promise.all([
        filter === "all" || filter === "album"
            ? client.search("release-group", { query: q, limit, offset })
            : null,
        filter === "all" || filter === "track"
            ? client.search("recording", { query: q, limit, offset })
            : null,
        filter === "all" || filter === "artist"
            ? client.search("artist", { query: q, limit, offset })
            : null
    ]);

    return {
        albums: albums ? albums["release-groups"].map(releaseGroupToMediaInfo) : [],
        tracks: tracks ? tracks.recordings.map(recordingToMediaInfo) : [],
        artists: artists ? artists.artists.map(toArtistInfo) : []
    };
});
