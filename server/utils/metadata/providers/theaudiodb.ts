// TheAudioDB (https://www.theaudiodb.com/free_music_api) - needs an API key in THEAUDIODB_API_KEY; `123` is
// the public test key, a personal (Patreon) key only raises limits. Skipped when unset. Free tier is about 30
// requests a minute. Track search needs both artist and title, so it only runs on `Artist - Title` queries.
// Its tracks carry MusicBrainz IDs, which saves the facade a MusicBrainz lookup.
import { providerFetchJson } from "../http";
import type { MetadataProvider, SongMetadata, TextQuery } from "../types";

interface AudioDbTrack {
    idTrack: string,
    idAlbum?: string,
    idArtist?: string,
    strTrack: string,
    strAlbum?: string | null,
    strArtist?: string | null,
    intDuration?: string | null,
    intTrackNumber?: string | null,
    strGenre?: string | null,
    strStyle?: string | null,
    strMood?: string | null,
    strTheme?: string | null,
    intTempo?: string | null,
    strKey?: string | null,
    strTimeSignature?: string | null,
    strDescriptionEN?: string | null,
    strTrackThumb?: string | null,
    strMusicVid?: string | null,
    strMusicBrainzID?: string | null,
    strMusicBrainzAlbumID?: string | null,
    strMusicBrainzArtistID?: string | null,
    intTotalListeners?: string | null,
    intTotalPlays?: string | null,
    intScore?: string | null
}

function apiKey(): string {
    return useRuntimeConfig().theaudiodbApiKey;
}

function get(path: string): Promise<{ track?: AudioDbTrack[] | null } | null> {
    return providerFetchJson("theaudiodb", `https://www.theaudiodb.com/api/v1/json/${encodeURIComponent(apiKey())}${path}`);
}

function num(value: string | null | undefined): number | null {
    if (!value) return null;
    const n = Number(value);
    return Number.isFinite(n) && n !== 0 ? n : null;
}

function toMetadata(track: AudioDbTrack): SongMetadata {
    const duration = num(track.intDuration);

    return {
        provider: "theaudiodb",
        ref: `theaudiodb:track:${track.idTrack}`,
        kind: "track",
        title: track.strTrack,
        artists: track.strArtist ? [track.strArtist] : [],
        album: track.strAlbum ?? null,
        duration: duration ? Math.round(duration / 1000) : null,
        isrc: null,
        releaseDate: null,
        genres: [track.strGenre, track.strStyle].filter((g): g is string => !!g),
        artwork: track.strTrackThumb ? [track.strTrackThumb] : [],
        previews: [],
        url: `https://www.theaudiodb.com/track/${track.idTrack}`,
        musicbrainzId: track.strMusicBrainzID || null,
        extra: {
            theaudiodbId: track.idTrack,
            musicbrainzAlbumId: track.strMusicBrainzAlbumID || null,
            musicbrainzArtistId: track.strMusicBrainzArtistID || null,
            trackNumber: num(track.intTrackNumber),
            mood: track.strMood || null,
            theme: track.strTheme || null,
            tempo: num(track.intTempo),
            key: track.strKey || null,
            timeSignature: track.strTimeSignature || null,
            description: track.strDescriptionEN || null,
            musicVideo: track.strMusicVid || null,
            listeners: num(track.intTotalListeners),
            plays: num(track.intTotalPlays),
            score: num(track.intScore)
        }
    };
}

export const theaudiodbProvider: MetadataProvider = {
    id: "theaudiodb",
    name: "TheAudioDB",
    enabled: () => !!apiKey(),

    async search(query: TextQuery, limit: number) {
        if (!query.title || !query.artist) return [];
        const res = await get(`/searchtrack.php?s=${encodeURIComponent(query.artist)}&t=${encodeURIComponent(query.title)}`);
        return (res?.track ?? []).slice(0, limit).map(toMetadata);
    },

    async byId(_kind: string, id: string) {
        if (!/^\d+$/.test(id)) return null;
        const res = await get(`/track.php?h=${id}`);
        const track = res?.track?.[0];
        return track ? toMetadata(track) : null;
    }
};
