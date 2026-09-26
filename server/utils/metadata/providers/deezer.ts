// Deezer public API (https://developers.deezer.com/api) - no key, 50 requests / 5 seconds per IP. Errors,
// including the quota one, come back as HTTP 200 with an `error` body.
import { coolDown, providerFetchJson } from "../http";
import type { MetadataProvider, SongMetadata, TextQuery } from "../types";

const API = "https://api.deezer.com";
const QUOTA_ERROR_CODE = 4;

interface DeezerArtist { id: number, name: string, picture_xl?: string }

interface DeezerAlbum {
    id: number,
    title: string,
    cover_xl?: string,
    cover_big?: string,
    release_date?: string,
    upc?: string,
    label?: string,
    nb_tracks?: number,
    duration?: number,
    link?: string,
    artist?: DeezerArtist,
    contributors?: DeezerArtist[],
    genres?: { data?: { name: string }[] }
}

interface DeezerTrack {
    id: number,
    title: string,
    isrc?: string,
    link?: string,
    duration?: number,
    release_date?: string,
    preview?: string,
    bpm?: number,
    gain?: number,
    rank?: number,
    explicit_lyrics?: boolean,
    track_position?: number,
    disk_number?: number,
    artist?: DeezerArtist,
    contributors?: DeezerArtist[],
    album?: DeezerAlbum
}

function acceptBody(body: unknown): boolean {
    const error = (body as { error?: { code?: number } } | null)?.error;
    if (!error) return true;
    if (error.code === QUOTA_ERROR_CODE) coolDown("deezer", 5000);
    return false;
}

function get<T>(path: string): Promise<T | null> {
    return providerFetchJson<T>("deezer", `${API}${path}`, { acceptBody });
}

function artistNames(main: DeezerArtist | undefined, contributors: DeezerArtist[] | undefined): string[] {
    const names = contributors?.map((c) => c.name) ?? [];
    if (main && !names.includes(main.name)) names.unshift(main.name);
    return names;
}

// genres only live on the album, so single lookups pay one extra request for them
async function albumGenres(albumId: number | undefined): Promise<string[]> {
    if (!albumId) return [];
    const album = await get<DeezerAlbum>(`/album/${albumId}`);
    return album?.genres?.data?.map((g) => g.name) ?? [];
}

function trackToMetadata(track: DeezerTrack, genres: string[] = []): SongMetadata {
    return {
        provider: "deezer",
        ref: `deezer:track:${track.id}`,
        kind: "track",
        title: track.title,
        artists: artistNames(track.artist, track.contributors),
        album: track.album?.title ?? null,
        duration: track.duration ?? null,
        isrc: track.isrc ?? null,
        releaseDate: track.release_date ?? track.album?.release_date ?? null,
        genres,
        artwork: [track.album?.cover_xl, track.album?.cover_big].filter((u): u is string => !!u),
        previews: track.preview ? [track.preview] : [],
        url: track.link ?? `https://www.deezer.com/track/${track.id}`,
        musicbrainzId: null,
        extra: {
            deezerId: track.id,
            bpm: track.bpm || null,
            gain: track.gain ?? null,
            rank: track.rank ?? null,
            explicit: track.explicit_lyrics ?? null,
            trackNumber: track.track_position ?? null,
            discNumber: track.disk_number ?? null,
            artistPicture: track.artist?.picture_xl ?? null
        }
    };
}

function albumToMetadata(album: DeezerAlbum): SongMetadata {
    return {
        provider: "deezer",
        ref: `deezer:album:${album.id}`,
        kind: "album",
        title: album.title,
        artists: artistNames(album.artist, album.contributors),
        album: album.title,
        duration: album.duration ?? null,
        isrc: null,
        releaseDate: album.release_date ?? null,
        genres: album.genres?.data?.map((g) => g.name) ?? [],
        artwork: [album.cover_xl, album.cover_big].filter((u): u is string => !!u),
        previews: [],
        url: album.link ?? `https://www.deezer.com/album/${album.id}`,
        musicbrainzId: null,
        extra: { deezerId: album.id, upc: album.upc ?? null, label: album.label ?? null, trackCount: album.nb_tracks ?? null }
    };
}

async function fullTrack(path: string): Promise<SongMetadata | null> {
    const track = await get<DeezerTrack>(path);
    if (!track?.id) return null;
    return trackToMetadata(track, await albumGenres(track.album?.id));
}

export const deezerProvider: MetadataProvider = {
    id: "deezer",
    name: "Deezer",
    enabled: () => true,

    async search(query: TextQuery, limit: number) {
        // plain terms: Deezer's documented `artist:"..." track:"..."` syntax currently matches nothing at all
        const q = query.title && query.artist ? `${query.artist} ${query.title}` : query.text;
        const res = await get<{ data?: DeezerTrack[] }>(`/search/track?q=${encodeURIComponent(q)}&limit=${limit}`);
        // search hits are partial (no contributors, genres or release date) - a ref lookup fills them in
        return res?.data?.map((t) => trackToMetadata(t)) ?? [];
    },

    async byIsrc(isrc: string) {
        const track = await fullTrack(`/track/isrc:${encodeURIComponent(isrc)}`);
        return track ? [track] : [];
    },

    async byId(kind: string, id: string) {
        if (!/^\d+$/.test(id)) return null;
        if (kind === "album") {
            const album = await get<DeezerAlbum>(`/album/${id}`);
            return album?.id ? albumToMetadata(album) : null;
        }
        return fullTrack(`/track/${id}`);
    }
};
