import { ArtistInfo } from "./ArtistInfo";
import { TrackInfo } from "./TrackInfo";

export interface DiscInfo {
    number: number,
    // the disc's own MusicBrainz title, or null when it has none - clients show "Disc {number}"
    title: string | null
}

// one release of the album's release-group (the standard edition, a Deluxe, another country, a reissue...): what
// "change release" offers. Open one with `GET /api/v1/album/{id}?release=<id>`
export interface AlbumRelease {
    id: string,
    title: string,
    // MusicBrainz' own words for what sets it apart ("deluxe edition", "2011 remaster"); null when it has none
    disambiguation: string | null,
    // "2010-11-02", "2010-11" or "2010"; null when undated
    date: string | null,
    country: string | null,
    // "Digital Media", "CD"... ("CD + DVD" for several)
    format: string | null,
    trackCount: number,
    // the release's own front cover (Cover Art Archive URL); null when it has none
    coverArt: string | null,
    // the release this response shows
    selected: boolean
}

export interface AlbumDetail {
    id: string,
    // the release the tracklist, label and (when it has its own) cover are of
    releaseId: string,
    // false when `?release=` picked a release other than the one the album is normally shown with - the album
    // can then only be requested track by track: a request downloads the standard edition's tracklist
    isDefaultRelease: boolean,
    // every official release of the release-group, oldest first, to choose another one from
    releases: AlbumRelease[],
    title: string,
    artist: ArtistInfo | string,
    type: "album" | "ep" | null,
    coverArt: string | null,
    // dominant colors extracted from `coverArt`, most-dominant first; empty when the cover couldn't be fetched
    imageColors: string[],
    // black or white, whichever contrasts best (WCAG) against `imageColors[0]`
    textColor: string,
    releaseDate: Date | null,
    // how much of releaseDate MusicBrainz knows ("2027" is padded to Jan 1 but only "year" precise)
    releaseDatePrecision: "day" | "month" | "year" | null,
    // false while the release date hasn't begun anywhere (server/utils/releaseDate.ts); can't be requested yet
    released: boolean,
    // whether the caller follows this upcoming album for a release notification
    subscribed: boolean,
    // whether the caller already has a waiting/in-progress request for this album
    requested: boolean,
    // whether every track of the album is already in the caller's library - it can't be requested again then
    inLibrary: boolean,
    description: string | null,
    label: string | null,
    // one entry per disc, in order; a single-disc album has exactly one and clients show no disc headers
    discs: DiscInfo[],
    tracks: TrackInfo[]
}
