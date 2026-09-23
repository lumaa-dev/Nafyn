// server-side contract every import provider (server/utils/transfer/providers/*) implements
import type { TransferAuthMode, TransferCapabilities, TransferPlaylistPreview, TransferProviderId } from "~~/server/entity/Transfer";

// one track as read from the source service, before any MusicBrainz matching
export interface SourceTrack {
    externalId: string | null,
    title: string | null,
    artist: string | null,
    album: string | null,
    isrc: string | null,
    durationMs: number | null,
    // set when the entry can never be imported (podcast episode, deleted video...); kept so it still counts
    unsupported?: boolean
}

export interface SourceAlbum {
    externalId: string | null,
    title: string | null,
    artist: string | null,
    upc: string | null
}

export interface SourceArtist {
    externalId: string | null,
    name: string | null
}

// a connected account. Held in memory only (sessions.ts) - never written to the database, never sent to a client
export interface ProviderSession {
    id: string,
    userId: string,
    provider: TransferProviderId,
    accessToken: string | null,
    // provider-specific bits discovered while connecting (user id, storefront, country...)
    data: Record<string, string>,
    // id -> title of the playlists the overview returned; a selection may only name these, so a client
    // can't point the server at arbitrary upstream paths
    playlists: Map<string, string>,
    expiresAt: number
}

export interface ProviderOverviewData {
    account: string | null,
    likedTracks: number | null,
    albums: number | null,
    artists: number | null,
    playlists: TransferPlaylistPreview[]
}

export interface OAuthTokens {
    accessToken: string,
    expiresIn: number | null
}

export interface TransferProvider {
    id: TransferProviderId,
    capabilities: TransferCapabilities,
    authModes(): TransferAuthMode[],
    isConfigured(): boolean,

    // OAuth providers only
    usesPkce?: boolean,
    authorizeUrl?(params: { state: string, redirectUri: string, codeChallenge: string }): string,
    exchangeCode?(params: { code: string, redirectUri: string, codeVerifier: string, state: string }): Promise<OAuthTokens>,

    // called once right after connecting, fills session.data (user id, country, display name...)
    init?(session: ProviderSession): Promise<void>,
    overview(session: ProviderSession): Promise<ProviderOverviewData>,

    likedTracks?(session: ProviderSession, max: number): Promise<SourceTrack[]>,
    albums?(session: ProviderSession, max: number): Promise<SourceAlbum[]>,
    artists?(session: ProviderSession, max: number): Promise<SourceArtist[]>,
    playlistTracks?(session: ProviderSession, playlistId: string, max: number): Promise<SourceTrack[]>
}
