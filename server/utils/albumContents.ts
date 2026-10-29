// What is on an album, as the search wants it: every track in order and every artist credited anywhere on it
// (the album's own credit, each track's, featurings included). Resolved exactly like the album page does -
// release-group lookup, release browse, `pickReleaseForGroup` - so the tracklist a search shows is the one the
// album page shows and the download pipeline tags against, and the album page then finds both requests cached.

import type { IArtistCredit, IRelease, IReleaseGroup } from "musicbrainz-api";
import type { MusicBrainzRepository } from "./musicbrainzRepository";
import { pickReleaseForGroup } from "./release";

export interface AlbumContents {
    albumId: string,
    albumTitle: string,
    albumType: "album" | "ep" | null,
    releaseId: string,
    /** The release-group's first release date, as MusicBrainz has it. */
    releaseDate: string | null,
    tracks: Array<{
        id: string,
        title: string,
        /** The whole credit as written: "A feat. B". */
        artist: { name: string, id: string | null },
        /** Milliseconds. */
        length: number | null,
        releaseDate: string | null
    }>,
    /** In order of appearance, the album's artist first. */
    artists: Array<{ id: string, name: string, disambiguation: string | null }>
}

// MusicBrainz' special-purpose "artists": credited on a track, but not somebody who is on the album
const PLACEHOLDER_ARTISTS = new Set([
    "89ad4ac3-39f7-470e-963a-56509c546377", // Various Artists
    "eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61", // [no artist]
    "125ec42a-7229-4250-afc5-e057484327fe", // [unknown]
    "f731ccc4-e22a-43af-a747-64213329e088", // [anonymous]
    "33cf029c-63b0-41a0-9855-be2a3665fb3b", // [data]
    "314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc" // [dialogue]
]);

function creditText(credits: IArtistCredit[] | undefined): { name: string, id: string | null } {
    if (!credits || credits.length === 0) return { name: "Unknown Artist", id: null };
    const name = credits.map((credit) => `${credit.name ?? credit.artist.name}${credit.joinphrase ?? ""}`).join("").trim();
    return { name: credits.length > 1 ? name : credits[0]!.artist.name, id: credits[0]!.artist.id };
}

/** Null when MusicBrainz knows no such release-group or none of its releases is usable. */
export async function getAlbumContents(client: Pick<MusicBrainzRepository, "lookup" | "browse">, releaseGroupId: string): Promise<AlbumContents | null> {
    // the same includes as GET /api/v1/album/{aid}, for the cache
    const releaseGroup: IReleaseGroup = await client.lookup("release-group", releaseGroupId, ["artist-credits"]);
    const browsed = await client.browse("release", { "release-group": releaseGroup.id }, ["recordings", "artist-credits", "labels", "media", "url-rels", "isrcs"]);
    const release: IRelease | undefined = pickReleaseForGroup(releaseGroup, browsed.releases);
    if (!release) return null;

    const artists = new Map<string, { id: string, name: string, disambiguation: string | null }>();
    const addCredits = (credits: IArtistCredit[] | undefined) => {
        for (const credit of credits ?? []) {
            const artist = credit.artist;
            if (!artist?.id || PLACEHOLDER_ARTISTS.has(artist.id) || artists.has(artist.id)) continue;
            artists.set(artist.id, { id: artist.id, name: artist.name, disambiguation: artist.disambiguation || null });
        }
    };
    addCredits(releaseGroup["artist-credit"]);

    const tracks: AlbumContents["tracks"] = [];
    for (const medium of release.media ?? []) {
        for (const track of medium.tracks ?? []) {
            if (!track.recording?.id) continue;
            // the credit the track carries on this release, else its recording's
            const credits = track["artist-credit"] ?? track.recording?.["artist-credit"] ?? releaseGroup["artist-credit"];
            addCredits(track["artist-credit"]);
            addCredits(track.recording?.["artist-credit"]);
            tracks.push({
                id: track.recording.id,
                title: track.title,
                artist: creditText(credits),
                length: track.length ?? track.recording.length ?? null,
                releaseDate: track.recording["first-release-date"] || null
            });
        }
    }

    const primaryType = releaseGroup["primary-type"]?.toLowerCase();
    return {
        albumId: releaseGroup.id,
        albumTitle: releaseGroup.title,
        albumType: primaryType === "album" || primaryType === "ep" ? primaryType : null,
        releaseId: release.id,
        releaseDate: releaseGroup["first-release-date"] || null,
        tracks,
        artists: [...artists.values()]
    };
}
