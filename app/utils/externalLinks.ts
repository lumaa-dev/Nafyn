// Links to the same song or album on other services, built from a search for "artist title": Nafyn knows no
// Spotify/Deezer/... ids, and a search page is what each service opens on anyway. Pure: no Nuxt auto-imports.

export type ExternalService = "spotify" | "appleMusic" | "deezer" | "youtube" | "youtubeMusic";

/** the order they are listed in, wherever they are */
export const EXTERNAL_SERVICES: readonly ExternalService[] = ["spotify", "appleMusic", "deezer", "youtube", "youtubeMusic"];

/** what is searched for: "artist title", either part skipped when unknown */
export function externalQuery(title: string | null | undefined, artist: string | null | undefined): string {
    return [artist, title].map((part) => part?.trim()).filter(Boolean).join(" ");
}

export function externalSearchUrl(service: ExternalService, query: string): string {
    const q = encodeURIComponent(query);
    switch (service) {
        case "spotify": return `https://open.spotify.com/search/${q}`;
        // no storefront in the path: Apple Music redirects to the visitor's own
        case "appleMusic": return `https://music.apple.com/search?term=${q}`;
        case "deezer": return `https://www.deezer.com/search/${q}`;
        case "youtube": return `https://www.youtube.com/results?search_query=${q}`;
        case "youtubeMusic": return `https://music.youtube.com/search?q=${q}`;
    }
}

/** the services' own names, never translated */
export const EXTERNAL_SERVICE_NAMES: Record<ExternalService, string> = {
    spotify: "Spotify",
    appleMusic: "Apple Music",
    deezer: "Deezer",
    youtube: "YouTube",
    youtubeMusic: "YouTube Music"
};
