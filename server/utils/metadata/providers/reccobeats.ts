// ReccoBeats (https://reccobeats.com/docs) - no key. Takes its own track IDs or Spotify track IDs, returns the
// ISRC plus Spotify-style audio features (tempo, energy, valence, ...). No text search, so it only answers
// ID lookups (including pasted Spotify links, see query.ts).
import { providerFetchJson } from "../http";
import type { MetadataProvider, SongMetadata } from "../types";

const API = "https://api.reccobeats.com/v1";

interface ReccoTrack {
    id: string,
    trackTitle: string,
    artists?: { id: string, name: string, href?: string }[],
    durationMs?: number,
    isrc?: string | null,
    ean?: string | null,
    upc?: string | null,
    href?: string,
    popularity?: number
}

interface ReccoAudioFeatures {
    acousticness?: number,
    danceability?: number,
    energy?: number,
    instrumentalness?: number,
    key?: number,
    liveness?: number,
    loudness?: number,
    mode?: number,
    speechiness?: number,
    tempo?: number,
    valence?: number
}

export const reccobeatsProvider: MetadataProvider = {
    id: "reccobeats",
    name: "ReccoBeats",
    enabled: () => true,

    async byId(_kind: string, id: string) {
        // ReccoBeats IDs are UUIDs, Spotify's are 22 base62 characters
        if (!/^[A-Za-z0-9-]{22,36}$/.test(id)) return null;

        const res = await providerFetchJson<{ content?: ReccoTrack[] }>("reccobeats", `${API}/track?ids=${encodeURIComponent(id)}`);
        const track = res?.content?.[0];
        if (!track) return null;

        const features = await providerFetchJson<ReccoAudioFeatures>("reccobeats", `${API}/track/${encodeURIComponent(track.id)}/audio-features`);
        const { acousticness, danceability, energy, instrumentalness, key, liveness, loudness, mode, speechiness, tempo, valence } = features ?? {};

        return {
            provider: "reccobeats",
            ref: `reccobeats:track:${track.id}`,
            kind: "track",
            title: track.trackTitle,
            artists: track.artists?.map((a) => a.name) ?? [],
            album: null,
            duration: track.durationMs ? Math.round(track.durationMs / 1000) : null,
            isrc: track.isrc ?? null,
            releaseDate: null,
            genres: [],
            artwork: [],
            previews: [],
            url: track.href ?? null,
            musicbrainzId: null,
            extra: {
                reccobeatsId: track.id,
                spotifyUrl: track.href ?? null,
                popularity: track.popularity ?? null,
                upc: track.upc ?? null,
                ean: track.ean ?? null,
                audioFeatures: features
                    ? { acousticness, danceability, energy, instrumentalness, key, liveness, loudness, mode, speechiness, tempo, valence }
                    : null
            }
        } satisfies SongMetadata;
    }
};
