export interface TrackInfo {
    id: string,
    title: string,
    // position within its disc, so a multi-disc album repeats 1..N once per disc
    trackNumber: number,
    // the disc (MusicBrainz medium position) the track is on; look it up in AlbumDetail.discs
    discNumber: number,
    duration: number,
    releaseDate: Date | null,
    released: boolean,
    inLibrary: boolean,
    requested: boolean,
    // the shared `media` row ID, if this recording has been downloaded by anyone; needed to add the track to a playlist
    mediaId: string | null
}
