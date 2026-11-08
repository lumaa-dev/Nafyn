import type { MediaInfo } from "./MediaInfo";

export type ReleaseCategoryId = "album" | "ep" | "single" | "compilation" | "live" | "remix" | "soundtrack" | "other";

// one card of an artist's page: a release-group, or - `releaseId` set - one edition of it (the Deluxe or
// Remaster release of an album that is a release inside the album's own release-group). Open an edition with
// the album's id and `?release=<releaseId>`.
export interface ArtistRelease extends Omit<MediaInfo, "relations"> {
    // the release-group (`id`) this card opens
    // the specific release to open it on; null for the release-group itself
    releaseId: string | null,
    // set when `releaseId` is a Deluxe or Remaster edition of an album that has a standard one
    edition: "deluxe" | "remaster" | null
}

// "Albums", "EPs", "Singles"... : the releases of that kind, newest first
export interface ReleaseCategory {
    id: ReleaseCategoryId,
    releases: ArtistRelease[]
}

export interface ArtistDetail {
    id: string,
    name: string,
    image: string | null,
    bio: string | null,
    listeners: number | null,
    // every release-group of the artist, newest first, all kinds mixed: the discography without its categories
    albums: MediaInfo[],
    // the same releases by kind, plus the Deluxe / Remaster editions of standard albums; empty kinds are left out
    categories: ReleaseCategory[]
}
