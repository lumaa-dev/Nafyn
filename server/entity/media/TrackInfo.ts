export interface TrackInfo {
    id: string,
    title: string,
    trackNumber: number,
    duration: number,
    releaseDate: Date | null,
    released: boolean,
    inLibrary: boolean,
    requested: boolean,
    // the shared `media` row ID, if this recording has been downloaded by anyone; needed to add the track to a playlist
    mediaId: string | null
}
