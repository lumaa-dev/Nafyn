// The slice of MusicBrainz search payloads the engine reads (checked against the live API, not the
// musicbrainz-api typings, which describe lookups and omit several search-only fields).

export interface RawAlias {
    name: string,
    "sort-name"?: string,
    locale?: string | null,
    primary?: boolean | null,
    type?: string | null
}

export interface RawArtist {
    id: string,
    name: string,
    "sort-name"?: string,
    aliases?: RawAlias[]
}

export interface RawArtistCredit {
    name?: string,
    joinphrase?: string,
    artist: RawArtist
}

export interface RawMedium {
    format?: string | null,
    /** In a recording search: this recording's track on the release, with the title *that release* gives it. */
    track?: Array<{ title?: string }>
}

export interface RawReleaseGroupRef {
    id: string,
    title?: string,
    "primary-type"?: string | null,
    "secondary-types"?: string[]
}

export interface RawRelease {
    id: string,
    title?: string,
    disambiguation?: string,
    status?: string | null,
    date?: string,
    barcode?: string | null,
    media?: RawMedium[],
    "release-group"?: RawReleaseGroupRef,
    "cover-art-archive"?: { front?: boolean, darkened?: boolean } | null
}

export interface RawReleaseGroup {
    id: string,
    title: string,
    disambiguation?: string,
    score?: number,
    "primary-type"?: string | null,
    "secondary-types"?: string[],
    "first-release-date"?: string,
    "artist-credit"?: RawArtistCredit[],
    releases?: RawRelease[]
}

export interface RawRecording {
    id: string,
    title: string,
    disambiguation?: string,
    score?: number,
    length?: number,
    isrcs?: Array<string | { id: string }>,
    "first-release-date"?: string,
    "artist-credit"?: RawArtistCredit[],
    releases?: RawRelease[]
}

export interface RawArtistHit {
    id: string,
    name: string,
    score?: number
}

export type ReleaseGroupSearch = { "release-groups"?: RawReleaseGroup[] };
export type RecordingSearch = { recordings?: RawRecording[] };
export type ReleaseSearch = { releases?: RawRelease[], count?: number };
export type ArtistSearch = { artists?: RawArtistHit[] };

// ---------------------------------------------------------------- engine output

export type MatchFlag =
    | "upc_match"
    | "isrc_match"
    | "code_contradiction"
    | "artist_only"
    | "swapped_order"
    | "transliterated"
    | "no_front_cover";

export interface MatchBreakdown {
    /** Containment score of the title (1 when no title was requested). */
    title: number,
    /** Best similarity of the requested artist against the credit, its aliases and sort names (1 when none requested). */
    artist: number,
    /** Final relevance: weighted title/artist plus corroboration and code bonuses. May exceed 1. */
    relevance: number,
    /** Levenshtein ratio of the full normalized titles, used as a ranking tie-break. */
    exactness: number,
    /** How many independent searches surfaced this candidate. */
    sources: number,
    flags: MatchFlag[]
}

export interface SearchResult {
    kind: "album" | "track",
    /** Release-group MBID (album) or recording MBID (track). */
    id: string,
    title: string,
    artist: { name: string, id: string | null },
    primaryType: string | null,
    secondaryTypes: string[],
    /** Earliest official digital release of this work. */
    releaseDate: string | null,
    /** The release the cover and the date were judged on. */
    releaseId: string | null,
    releaseTitle: string | null,
    albumId: string | null,
    /** Track length in milliseconds. */
    length: number | null,
    hasFrontCover: boolean,
    match: MatchBreakdown,
    bestResult: boolean
}
