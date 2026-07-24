import { ArtistInfo } from "./ArtistInfo";
import { TrackInfo } from "./TrackInfo";

export interface AlbumDetail {
    id: string,
    releaseId: string,
    title: string,
    artist: ArtistInfo | string,
    type: "album" | "ep" | null,
    coverArt: string | null,
    releaseDate: Date | null,
    description: string | null,
    label: string | null,
    tracks: TrackInfo[]
}
