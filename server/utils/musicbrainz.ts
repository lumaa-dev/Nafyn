import type { IReleaseGroup, IRelease, IRecording, RecordingIncludes } from "musicbrainz-api";
import { APP_NAME, APP_VERSION, APP_GITHUB } from "./app";
import { MusicBrainzRepository } from "./musicbrainzRepository";
import type { MediaInfo } from "../entity/media/MediaInfo";
import type { ArtistInfo } from "../entity/media/ArtistInfo";
import { pickCanonicalRelease, pickReleaseForGroup } from "./release";

let repository: MusicBrainzRepository | null = null;

// The one include list a recording is looked up with, by the track page, GET /api/v1/track/isrc, getMediaInfo and the
// download pipeline (resolveTargets): the repository caches per URL, so one list means one MusicBrainz call where
// four different lists used to cost four. (`release-groups` is valid on MusicBrainz, missing from musicbrainz-api's
// types, hence the plain string array.)
export const TRACK_LOOKUP_INC: string[] = ["artist-credits", "releases", "release-groups", "media", "url-rels", "isrcs"];

// The shared MusicBrainz repository: every request to MusicBrainz in Nafyn goes through this one instance, so
// the 1 request/second limiter, retry, circuit breaker and cache are global. Identifies Nafyn with its app
// name/version/contact per MusicBrainz's API requirements.
export function getMusicBrainzRepository(): MusicBrainzRepository {
	if (!repository) {
		repository = new MusicBrainzRepository({
			userAgent: `${APP_NAME}/${APP_VERSION} ( ${APP_GITHUB} )`,
		});
	}
	return repository;
}

export function parseReleaseDate(date: string | undefined): Date | null {
	if (!date) return null;
	const parsed = new Date(date);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// fetches a single recording (track) from MusicBrainz and maps it to a MediaInfo
async function getTrackMediaInfo(
	client: MusicBrainzRepository,
	musicbrainzId: string,
): Promise<MediaInfo> {
	const recording: IRecording = await client.lookup("recording", musicbrainzId, TRACK_LOOKUP_INC as RecordingIncludes[]);
	// shared release picker (see utils/release.ts) so every surface agrees on which release a recording belongs to
	const release = pickCanonicalRelease(recording.releases);
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
	client: MusicBrainzRepository,
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
	const release: IRelease | undefined = pickReleaseForGroup(releaseGroup, browsed.releases);

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
	const client = getMusicBrainzRepository();
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