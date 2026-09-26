// iTunes Search/Lookup API (https://performance-partners.apple.com/search-api) - no key, roughly 20 requests a
// minute per IP, answered with a 403 (not a 429) once exceeded. Carries no ISRC.
import { providerFetchJson } from "../http";
import type { MetadataProvider, SongMetadata, TextQuery } from "../types";

const API = "https://itunes.apple.com";

interface ItunesItem {
    wrapperType: "track" | "collection" | "artist",
    trackId?: number,
    collectionId?: number,
    artistId?: number,
    trackName?: string,
    collectionName?: string,
    artistName?: string,
    trackTimeMillis?: number,
    releaseDate?: string,
    primaryGenreName?: string,
    artworkUrl100?: string,
    previewUrl?: string,
    trackViewUrl?: string,
    collectionViewUrl?: string,
    trackNumber?: number,
    trackCount?: number,
    discNumber?: number,
    trackExplicitness?: string,
    country?: string,
    copyright?: string
}

function get(path: string): Promise<{ results?: ItunesItem[] } | null> {
    return providerFetchJson("itunes", `${API}${path}`, { rateLimitStatuses: [403] });
}

// artwork URLs end in `/100x100bb.jpg`; the CDN serves any size asked for
function artwork(url: string | undefined): string[] {
    if (!url) return [];
    return [url.replace(/\/\d+x\d+bb\./, "/1000x1000bb."), url.replace(/\/\d+x\d+bb\./, "/600x600bb.")];
}

function toMetadata(item: ItunesItem): SongMetadata | null {
    const isTrack = item.wrapperType === "track";
    const id = isTrack ? item.trackId : item.collectionId;
    const title = isTrack ? item.trackName : item.collectionName;
    if (!id || !title) return null;

    return {
        provider: "itunes",
        ref: `itunes:${isTrack ? "track" : "album"}:${id}`,
        kind: isTrack ? "track" : "album",
        title,
        artists: item.artistName ? [item.artistName] : [],
        album: item.collectionName ?? null,
        duration: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : null,
        isrc: null,
        releaseDate: item.releaseDate?.slice(0, 10) ?? null,
        genres: item.primaryGenreName ? [item.primaryGenreName] : [],
        artwork: artwork(item.artworkUrl100),
        previews: item.previewUrl ? [item.previewUrl] : [],
        url: (isTrack ? item.trackViewUrl : item.collectionViewUrl) ?? null,
        musicbrainzId: null,
        extra: {
            itunesTrackId: item.trackId ?? null,
            itunesCollectionId: item.collectionId ?? null,
            itunesArtistId: item.artistId ?? null,
            trackNumber: item.trackNumber ?? null,
            trackCount: item.trackCount ?? null,
            discNumber: item.discNumber ?? null,
            explicit: item.trackExplicitness ? item.trackExplicitness === "explicit" : null,
            country: item.country ?? null,
            copyright: item.copyright ?? null
        }
    };
}

export const itunesProvider: MetadataProvider = {
    id: "itunes",
    name: "iTunes",
    enabled: () => true,

    async search(query: TextQuery, limit: number) {
        const term = query.title && query.artist ? `${query.artist} ${query.title}` : query.text;
        const res = await get(`/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=${limit}`);
        return (res?.results ?? []).map(toMetadata).filter((m): m is SongMetadata => m !== null);
    },

    async byId(_kind: string, id: string) {
        if (!/^\d+$/.test(id)) return null;
        // one lookup endpoint for tracks and albums alike, the result's wrapperType says which it was
        const res = await get(`/lookup?id=${id}`);
        const item = res?.results?.[0];
        return item ? toMetadata(item) : null;
    }
};
