import { ArtistInfo } from "./ArtistInfo"

export interface MediaInfo {
    id: string,
    title: string,
    artist: ArtistInfo | string,
    album: MediaAlbumInfo | null,
    type: "album" | "ep" | "track" | null,
    coverArt: string | null,
    // dominant colors extracted from `coverArt`, most-dominant first; only populated by single-item lookups
    // (getTrack/getTrackByIsrc) - too expensive to compute per row for list endpoints like search
    imageColors?: string[],
    // black or white, whichever contrasts best (WCAG) against `imageColors[0]`; only set alongside `imageColors`
    textColor?: string,
    releaseDate: Date | null,
    inLibrary: boolean | null,
    duration: number,
    label: string | null,
    relations: MediaRelations
}

interface MediaAlbumInfo {
    id: string | null,
    type: "album" | "ep" | null,
    title: string | null
}

interface MediaRelations {
    /** Apple Music identifier */
    amId: string | undefined;
}