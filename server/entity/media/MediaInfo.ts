import { ArtistInfo } from "./ArtistInfo"

export interface MediaInfo {
    id: string,
    title: string,
    artist: ArtistInfo | string,
    album: MediaAlbumInfo | null,
    type: "album" | "ep" | "track" | null,
    coverArt: string | null,
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