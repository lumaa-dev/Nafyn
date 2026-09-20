import { ArtistInfo } from "./ArtistInfo";
import { TrackInfo } from "./TrackInfo";

export interface AlbumDetail {
    id: string,
    releaseId: string,
    title: string,
    artist: ArtistInfo | string,
    type: "album" | "ep" | null,
    coverArt: string | null,
    // dominant colors extracted from `coverArt`, most-dominant first; empty when the cover couldn't be fetched
    imageColors: string[],
    // black or white, whichever contrasts best (WCAG) against `imageColors[0]`
    textColor: string,
    releaseDate: Date | null,
    description: string | null,
    label: string | null,
    tracks: TrackInfo[]
}
