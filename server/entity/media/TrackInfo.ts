export interface TrackInfo {
    id: string,
    title: string,
    trackNumber: number,
    duration: number,
    releaseDate: Date | null,
    released: boolean,
    inLibrary: boolean,
    requested: boolean
}
