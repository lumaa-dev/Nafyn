import type { ArtistInfo } from "./ArtistInfo";
import type { MediaInfo } from "./MediaInfo";

// One row of the search list (GET /api/v1/search `results`): a track, an album or an artist, in a single ranking
// where the first row is the most likely answer and the last the least likely.
export interface SearchEntry {
    kind: "track" | "album" | "artist",
    // 0..1 (a result with a UPC/ISRC match may exceed 1): how well the row matches the query, comparable across kinds
    relevance: number,
    // the track or album, when `kind` is `track` or `album`; null for an artist
    media: Omit<MediaInfo, "relations"> | null,
    // the artist, when `kind` is `artist`; null otherwise
    artist: ArtistInfo | null
}
