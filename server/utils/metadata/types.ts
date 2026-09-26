// shared shapes for the song metadata facade (server/utils/metadata/index.ts). Every provider maps its own
// response onto SongMetadata, so callers never see a provider-specific payload outside of `extra`.

export type MetadataProviderId = "deezer" | "itunes" | "reccobeats" | "discogs" | "theaudiodb" | "genius";

export interface SongMetadata {
    provider: MetadataProviderId,
    // platform id this record can be looked up again with, in the `provider:kind:id` form query.ts parses
    // (e.g. `deezer:track:3135556`) - the search page links unresolved results through it
    ref: string,
    // Discogs only knows releases, and album links are accepted as queries, so not every record is a track
    kind: "track" | "album",
    title: string,
    artists: string[],
    album: string | null,
    // seconds
    duration: number | null,
    isrc: string | null,
    // as precise as the provider gives it: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`
    releaseDate: string | null,
    genres: string[],
    // largest first
    artwork: string[],
    // short audio clips (Deezer's are signed URLs that expire after a while)
    previews: string[],
    // the record's page on the provider's own site
    url: string | null,
    // MusicBrainz recording ID, when the provider carries one (TheAudioDB) or the facade resolved it
    musicbrainzId: string | null,
    // anything else the provider returns that's worth keeping (BPM, audio features, credits, bio, ...)
    extra: Record<string, unknown>
}

export interface TextQuery {
    type: "text",
    text: string,
    // filled when the query reads `Artist - Title`, which lets providers that need both fields separately
    // (TheAudioDB, Discogs' fielded search) take part
    title: string | null,
    artist: string | null
}

export interface IsrcQuery {
    type: "isrc",
    isrc: string
}

export interface IdQuery {
    type: "id",
    provider: MetadataProviderId,
    // provider-specific: `track`/`album` (Deezer, iTunes), `release`/`master` (Discogs), `song` (Genius),
    // `track`/`spotify` (ReccoBeats), `track` (TheAudioDB)
    kind: string,
    id: string
}

export type MetadataQuery = TextQuery | IsrcQuery | IdQuery;

export interface MetadataLookupResult {
    query: MetadataQuery,
    // MusicBrainz recording the lookup resolved to (ISRC and platform-ID lookups only), i.e. what can be
    // opened and requested in Nafyn
    musicbrainzId: string | null,
    results: SongMetadata[],
    providers: MetadataProviderId[]
}

export interface MetadataProvider {
    id: MetadataProviderId,
    name: string,
    // false when the provider needs a key/token that isn't set - the facade then skips it silently
    enabled(): boolean,
    search?(query: TextQuery, limit: number): Promise<SongMetadata[]>,
    byIsrc?(isrc: string): Promise<SongMetadata[]>,
    byId?(kind: string, id: string): Promise<SongMetadata | null>
}
