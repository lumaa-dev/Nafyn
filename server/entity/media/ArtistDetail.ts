import type { MediaInfo } from "./MediaInfo";

export interface ArtistDetail {
    id: string,
    name: string,
    image: string | null,
    bio: string | null,
    listeners: number | null,
    albums: MediaInfo[]
}
