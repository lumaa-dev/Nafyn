// parses a free-form search box entry into a metadata query. Pure (no Nitro globals) on purpose: the search
// page imports it too, to tell a plain text search from an ISRC or a pasted link before calling anything.
import type { MetadataProviderId, MetadataQuery } from "./types";

const ISRC_PATTERN = /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i;

const PROVIDER_ALIASES: Record<string, MetadataProviderId> = {
    deezer: "deezer",
    dz: "deezer",
    itunes: "itunes",
    apple: "itunes",
    am: "itunes",
    reccobeats: "reccobeats",
    rb: "reccobeats",
    // ReccoBeats accepts Spotify track IDs in place of its own, so that's where Spotify links end up
    spotify: "reccobeats",
    discogs: "discogs",
    theaudiodb: "theaudiodb",
    audiodb: "theaudiodb",
    tadb: "theaudiodb",
    genius: "genius"
};

const DEFAULT_KIND: Record<MetadataProviderId, string> = {
    deezer: "track",
    itunes: "track",
    reccobeats: "track",
    discogs: "release",
    theaudiodb: "track",
    genius: "song"
};

const PREFIXED_PATTERN = /^([a-z]+):(?:([a-z]+):)?([A-Za-z0-9-]+)$/i;

function fromUrl(raw: string): MetadataQuery | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }

    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname;
    let match: RegExpMatchArray | null;

    if (host === "deezer.com" && (match = path.match(/\/(track|album)\/(\d+)/))) {
        return { type: "id", provider: "deezer", kind: match[1]!, id: match[2]! };
    }

    if (host === "music.apple.com" || host === "itunes.apple.com") {
        // album links point at a single track through `?i=`
        const trackId = url.searchParams.get("i");
        if (trackId && /^\d+$/.test(trackId)) return { type: "id", provider: "itunes", kind: "track", id: trackId };
        if ((match = path.match(/\/song\/(?:[^/]+\/)?(?:id)?(\d+)/))) return { type: "id", provider: "itunes", kind: "track", id: match[1]! };
        if ((match = path.match(/\/album\/(?:[^/]+\/)?(?:id)?(\d+)/))) return { type: "id", provider: "itunes", kind: "album", id: match[1]! };
    }

    if (host === "open.spotify.com" && (match = path.match(/\/track\/([A-Za-z0-9]{22})/))) {
        return { type: "id", provider: "reccobeats", kind: "spotify", id: match[1]! };
    }

    if (host === "discogs.com" && (match = path.match(/\/(release|master)\/(\d+)/))) {
        return { type: "id", provider: "discogs", kind: match[1]!, id: match[2]! };
    }

    if (host === "genius.com" && (match = path.match(/^\/songs\/(\d+)/))) {
        return { type: "id", provider: "genius", kind: "song", id: match[1]! };
    }

    if (host === "theaudiodb.com" && (match = path.match(/^\/track\/(\d+)/))) {
        return { type: "id", provider: "theaudiodb", kind: "track", id: match[1]! };
    }

    return null;
}

export function parseMetadataQuery(input: string): MetadataQuery | null {
    const text = input.trim();
    if (!text) return null;

    if (ISRC_PATTERN.test(text)) {
        return { type: "isrc", isrc: text.replace(/-/g, "").toUpperCase() };
    }

    if (/^https?:\/\//i.test(text)) {
        return fromUrl(text);
    }

    const prefixed = text.match(PREFIXED_PATTERN);
    const provider = prefixed ? PROVIDER_ALIASES[prefixed[1]!.toLowerCase()] : undefined;
    if (prefixed && provider) {
        const alias = prefixed[1]!.toLowerCase();
        const kind = alias === "spotify" ? "spotify" : prefixed[2]?.toLowerCase() ?? DEFAULT_KIND[provider];
        return { type: "id", provider, kind, id: prefixed[3]! };
    }

    // `Artist - Title`, the only split that's unambiguous enough to hand providers as separate fields
    const dash = text.indexOf(" - ");
    const artist = dash > 0 ? text.slice(0, dash).trim() : null;
    const title = dash > 0 ? text.slice(dash + 3).trim() : null;

    return { type: "text", text, title: title || null, artist: artist || null };
}

// true for anything that isn't a plain text search - an ISRC, a platform ID or a supported link
export function isStructuredMetadataQuery(input: string): boolean {
    const parsed = parseMetadataQuery(input);
    return parsed !== null && parsed.type !== "text";
}
