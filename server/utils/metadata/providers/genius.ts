// Genius API (https://docs.genius.com) - needs a client access token (GENIUS_ACCESS_TOKEN, free from
// https://genius.com/api-clients); skipped when unset. The API serves song info and annotations but never
// the lyrics text itself, so this is for credits, descriptions, release dates and artwork.
import { providerFetchJson } from "../http";
import type { MetadataProvider, SongMetadata, TextQuery } from "../types";

const API = "https://api.genius.com";
const MAX_DESCRIPTION_LENGTH = 2000;

interface GeniusArtist { id: number, name: string, image_url?: string }

interface GeniusSong {
    id: number,
    title: string,
    full_title?: string,
    url?: string,
    primary_artist?: GeniusArtist,
    primary_artists?: GeniusArtist[],
    featured_artists?: GeniusArtist[],
    producer_artists?: GeniusArtist[],
    writer_artists?: GeniusArtist[],
    song_art_image_url?: string,
    header_image_url?: string,
    release_date?: string | null,
    release_date_components?: { year?: number, month?: number | null, day?: number | null } | null,
    album?: { name: string, cover_art_url?: string } | null,
    description?: { plain?: string } | null,
    media?: { provider: string, url: string }[],
    apple_music_id?: string | null,
    recording_location?: string | null,
    stats?: { pageviews?: number },
    lyrics_state?: string
}

function accessToken(): string {
    return useRuntimeConfig().geniusAccessToken;
}

function get<T>(path: string): Promise<{ response?: T } | null> {
    return providerFetchJson("genius", `${API}${path}`, { headers: { Authorization: `Bearer ${accessToken()}` } });
}

function releaseDate(song: GeniusSong): string | null {
    if (song.release_date) return song.release_date;
    const c = song.release_date_components;
    if (!c?.year) return null;
    return [c.year, c.month, c.day].filter((p) => p != null).map((p) => String(p).padStart(2, "0")).join("-");
}

function names(artists: GeniusArtist[] | undefined): string[] {
    return artists?.map((a) => a.name) ?? [];
}

function toMetadata(song: GeniusSong): SongMetadata {
    const primary = song.primary_artists?.length ? names(song.primary_artists) : names(song.primary_artist ? [song.primary_artist] : []);
    const description = song.description?.plain?.trim();

    return {
        provider: "genius",
        ref: `genius:song:${song.id}`,
        kind: "track",
        title: song.title,
        artists: [...primary, ...names(song.featured_artists).filter((n) => !primary.includes(n))],
        album: song.album?.name ?? null,
        duration: null,
        isrc: null,
        releaseDate: releaseDate(song),
        genres: [],
        artwork: [song.song_art_image_url, song.album?.cover_art_url, song.header_image_url].filter((u, i, all): u is string => !!u && all.indexOf(u) === i),
        previews: [],
        url: song.url ?? null,
        musicbrainzId: null,
        extra: {
            geniusId: song.id,
            // Genius' placeholder when nobody has written one is literally "?"
            description: description && description !== "?" ? description.slice(0, MAX_DESCRIPTION_LENGTH) : null,
            producers: names(song.producer_artists),
            writers: names(song.writer_artists),
            recordingLocation: song.recording_location ?? null,
            appleMusicId: song.apple_music_id ?? null,
            media: song.media?.map((m) => ({ provider: m.provider, url: m.url })) ?? [],
            pageviews: song.stats?.pageviews ?? null,
            lyricsState: song.lyrics_state ?? null
        }
    };
}

export const geniusProvider: MetadataProvider = {
    id: "genius",
    name: "Genius",
    enabled: () => !!accessToken(),

    async search(query: TextQuery, limit: number) {
        const q = query.title && query.artist ? `${query.artist} ${query.title}` : query.text;
        const res = await get<{ hits?: { type: string, result: GeniusSong }[] }>(`/search?q=${encodeURIComponent(q)}`);
        return (res?.response?.hits ?? []).filter((h) => h.type === "song").slice(0, limit).map((h) => toMetadata(h.result));
    },

    async byId(_kind: string, id: string) {
        if (!/^\d+$/.test(id)) return null;
        const res = await get<{ song?: GeniusSong }>(`/songs/${id}?text_format=plain`);
        return res?.response?.song ? toMetadata(res.response.song) : null;
    }
};
