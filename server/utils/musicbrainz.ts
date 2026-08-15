import {
	MusicBrainzApi,
	IReleaseGroup,
	IRelease,
	IRecording,
} from "musicbrainz-api";
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
			appContactInfo: APP_GITHUB,
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
async function getTrackMediaInfo(
	client: MusicBrainzApi,
	musicbrainzId: string,
): Promise<MediaInfo> {
	const recording = await client.lookup("recording", musicbrainzId, [
		"artist-credits",
		"releases",
		"url-rels"
	]);
	const release = recording.releases?.[0];
	const credit = recording["artist-credit"]?.[0]?.artist;

	const artist: ArtistInfo | string = credit
		? {
				name: credit.name,
				musicbrainzId: credit.id,
				description: null,
				image: null,
			}
        : "Unknown Artist";
    
    const amId: string | undefined = getAppleMusicTrackID(recording, release);

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
        label: null,
        relations: {
            amId
        }
	};
}

// fetches a release-group (album/EP) from MusicBrainz and maps it to a MediaInfo
async function getAlbumMediaInfo(
	client: MusicBrainzApi,
	musicbrainzId: string,
): Promise<MediaInfo> {
	const releaseGroup: IReleaseGroup = await client.lookup(
		"release-group",
		musicbrainzId,
		["artist-credits", "url-rels"],
	);
	const browsed = await client.browse(
		"release",
		{ "release-group": musicbrainzId },
		["labels"],
	);
	const release: IRelease | undefined = browsed.releases[0];

	const primaryType = releaseGroup["primary-type"]?.toLowerCase();
	const type =
		primaryType === "album" || primaryType === "ep" ? primaryType : null;
	const label = release?.["label-info"]?.[0]?.label?.name ?? null;
	const credit = releaseGroup["artist-credit"]?.[0]?.artist;

	const artist: ArtistInfo | string = credit
		? {
				name: credit.name,
				musicbrainzId: credit.id,
				description: null,
				image: null,
			}
		: "Unknown Artist";
	
	const amId: string | undefined = getAppleMusicTrackID(undefined, release);

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
		label,
		relations: {
			amId
		}
	};
}

// fetches a MusicBrainz entity (track or album) and maps it into Nafyn's MediaInfo shape
export async function getMediaInfo(
	musicbrainzId: string,
	type: "album" | "track",
): Promise<MediaInfo> {
	const client = getMusicBrainzClient();
	return type === "track"
		? getTrackMediaInfo(client, musicbrainzId)
		: getAlbumMediaInfo(client, musicbrainzId);
}

export function getAppleMusicTrackID(recording?: IRecording, release?: IRelease): string | undefined {
	const relationSets = [recording?.relations, release?.relations];

	for (const relations of relationSets) {		
		if (!relations) continue;
		
		for (const relation of relations) {
			if (!relation.url?.resource.includes("music.apple.com")) continue;

			console.log(`[getAppleMusicTrackID] apple music link: ${relation.url?.resource}`);
            const ids: RegExpExecArray[] = (relation.url?.resource ?? "").matchAll(/\d+/g).toArray();
            if (ids.length <= 0) continue;

			let id: string | undefined = ids[ids.length - 1]?.[0]
			console.log(`[getAppleMusicTrackID] found track id: ${id}`);
			
			if (id) return id;
		}
	}

	return undefined;
}