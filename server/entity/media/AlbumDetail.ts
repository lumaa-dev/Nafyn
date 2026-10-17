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
    // how much of releaseDate MusicBrainz knows ("2027" is padded to Jan 1 but only "year" precise)
    releaseDatePrecision: "day" | "month" | "year" | null,
    // false while the release date hasn't begun anywhere (server/utils/releaseDate.ts); can't be requested yet
    released: boolean,
    // whether the caller follows this upcoming album for a release notification
    subscribed: boolean,
    description: string | null,
    label: string | null,
    tracks: TrackInfo[]
}
