import { MusicBrainzApi, IReleaseGroup, IRelease } from "musicbrainz-api";
import { APP_NAME, APP_VERSION, APP_GITHUB } from "./app";
import type { MediaInfo } from "../entity/media/MediaInfo";
import type { ArtistInfo } from "../entity/media/ArtistInfo";

let client: MusicBrainzApi | null = null;

// shared MusicBrainz client, identifies Nafyn with its app name/version/contact per MusicBrainz's API requirements
export function getMusicBrainzClient(): MusicBrainzApi {
    if (!client) {
        client = new MusicBrainzApi({
            appName: APP_NAME,
            appVersion: APP_VERSION,
            appContactInfo: APP_GITHUB
        });
    }
    return client;
}

export function parseReleaseDate(date: string | undefined): Date | null {
    if (!date) return null;
    const parsed = new Date(date);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// fetches a single recording (track) from MusicBrainz and maps it to a MediaInfo
async function getTrackMediaInfo(client: MusicBrainzApi, musicbrainzId: string): Promise<MediaInfo> {
    const recording = await client.lookup("recording", musicbrainzId, ["artist-credits", "releases"]);
    const release = recording.releases?.[0];
    const credit = recording["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit
        ? { name: credit.name, musicbrainzId: credit.id, description: null, image: null }
        : "Unknown Artist";

    return {
        id: recording.id,
        title: recording.title,
        artist,
        album: release ? { id: release.id, type: null, title: release.title } : null,
        type: "track",
        coverArt: release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
        releaseDate: parseReleaseDate(recording["first-release-date"]),
        inLibrary: null,
        duration: recording.length ? Math.round(recording.length / 1000) : 0,
        label: null
    };
}

// fetches a release-group (album/EP) from MusicBrainz and maps it to a MediaInfo
async function getAlbumMediaInfo(client: MusicBrainzApi, musicbrainzId: string): Promise<MediaInfo> {
    const releaseGroup: IReleaseGroup = await client.lookup("release-group", musicbrainzId, ["artist-credits"]);
    const browsed = await client.browse("release", { "release-group": musicbrainzId }, ["labels"]);
    const release: IRelease | undefined = browsed.releases[0];

    const primaryType = releaseGroup["primary-type"]?.toLowerCase();
    const type = primaryType === "album" || primaryType === "ep" ? primaryType : null;
    const label = release?.["label-info"]?.[0]?.label?.name ?? null;
    const credit = releaseGroup["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit
        ? { name: credit.name, musicbrainzId: credit.id, description: null, image: null }
        : "Unknown Artist";

    return {
        id: releaseGroup.id,
        title: releaseGroup.title,
        artist,
        album: { id: releaseGroup.id, type, title: releaseGroup.title },
        type,
        coverArt: `https://coverartarchive.org/release-group/${releaseGroup.id}/front-250`,
        releaseDate: parseReleaseDate(releaseGroup["first-release-date"]),
        inLibrary: null,
        duration: 0,
        label
    };
}

// fetches a MusicBrainz entity (track or album) and maps it into Nafyn's MediaInfo shape
export async function getMediaInfo(musicbrainzId: string, type: "album" | "track"): Promise<MediaInfo> {
    const client = getMusicBrainzClient();
    return type === "track"
        ? getTrackMediaInfo(client, musicbrainzId)
        : getAlbumMediaInfo(client, musicbrainzId);
}
