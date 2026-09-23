// shapes shared by the import ("transfer") API and the pages that drive it

export type TransferProviderId = "spotify" | "apple" | "deezer" | "soundcloud" | "youtube" | "tidal" | "amazon" | "napster";
export type TransferSourceId = TransferProviderId | "file";

export type TransferJobStatus = "fetching" | "matching" | "downloading" | "completed" | "failed" | "cancelled";
export type TransferItemStatus = "pending" | "matching" | "matched" | "requested" | "completed" | "failed" | "skipped";
export type TransferItemKind = "track" | "album" | "artist";
export type TransferItemSource = "liked" | "playlist" | "album" | "artist" | "file";

// why an item could not be imported, surfaced to the user as a count per reason and per item
export type TransferFailReason =
    | "missing_isrc"      // no ISRC from the source, and a title/artist search found no confident match either
    | "missing_upc"       // same, for an album and its barcode
    | "missing_data"      // not even a usable title/artist to search with
    | "not_found"         // had an ISRC/UPC, but MusicBrainz doesn't know it and the search fallback failed too
    | "unsupported"       // a podcast episode, a local file, a video, a deleted/private item...
    | "no_permission"     // the account lacks REQUEST_TRACKS / REQUEST_ALBUMS
    | "download_failed";  // matched fine, but Soulseek had no verifiable copy

// how a connected account signs in: a full OAuth redirect, Apple's MusicKit JS prompt, or just a public
// profile link (Deezer, whose developer app registration has been closed for years)
export type TransferAuthMode = "oauth" | "musickit" | "profile";

export interface TransferProviderStatus {
    id: TransferProviderId,
    configured: boolean,
    authModes: TransferAuthMode[]
}

export interface TransferPlaylistPreview {
    id: string,
    title: string,
    trackCount: number | null,
    image: string | null
}

export interface TransferCapabilities {
    likedTracks: boolean,
    albums: boolean,
    artists: boolean,
    playlists: boolean
}

// what the connected account holds, shown before anything is imported so the user can pick
export interface TransferOverview {
    sessionId: string,
    provider: TransferProviderId,
    account: string | null,
    capabilities: TransferCapabilities,
    likedTracks: number | null,
    albums: number | null,
    artists: number | null,
    playlists: TransferPlaylistPreview[]
}

export interface TransferSelection {
    likedTracks: boolean,
    albums: boolean,
    artists: boolean,
    playlists: string[]
}

export interface TransferJobCounts {
    pending: number,
    matched: number,
    requested: number,
    completed: number,
    failed: number,
    skipped: number
}

export interface TransferJob {
    id: string,
    provider: TransferSourceId,
    status: TransferJobStatus,
    error: string | null,
    totalItems: number,
    truncated: boolean,
    createdAt: number,
    updatedAt: number,
    finishedAt: number | null,
    counts: TransferJobCounts,
    alreadyOwned: number,
    failures: Partial<Record<TransferFailReason, number>>,
    kinds: Record<TransferItemKind, number>
}

export interface TransferItem {
    id: string,
    position: number,
    kind: TransferItemKind,
    source: TransferItemSource,
    title: string | null,
    artistName: string | null,
    albumName: string | null,
    isrc: string | null,
    upc: string | null,
    status: TransferItemStatus,
    failReason: TransferFailReason | null,
    alreadyOwned: boolean,
    musicbrainzId: string | null,
    matchedBy: "isrc" | "upc" | "search" | null,
    playlistTitle: string | null
}
