import noCover from '~/assets/no-cover.png';

// A track can carry two kinds of cover: a Cover Art Archive URL on `coverArt` (what the download pipeline
// writes) and a user-uploaded image on disk, flagged by `hasCustomCover` and served by
// GET /api/v1/library/{id}/cover. The uploaded one always wins.
//
// That endpoint authenticates from the `nafynToken` cookie as well as the header, precisely so the URL can
// go straight into an <img src> - a plain <img> can't send an Authorization header.
interface CoverSource {
    id?: string | null,
    coverArt?: string | null,
    hasCustomCover?: number | boolean | null,
    /** Album listings carry the media ID of a track with an uploaded cover instead of a flag. */
    coverMediaId?: string | null
}

// What a cover URL looks like when it reaches the app: Nafyn's own `/api/v1/art/<release|release-group>/<uuid>/<size>`
// (every /api/v1 response is rewritten to it), or - from a source that bypassed the API - the stored
// `https://coverartarchive.org/release[-group]/<uuid>/front-<size>`.
const CAA_FRONT = /^(?:https:\/\/coverartarchive\.org|\/api\/v1\/art)\/(release|release-group)\/([0-9a-f-]{36})\/(?:front-)?\d+$/i;

export type CoverSize = 250 | 500 | 1000;

// A Cover Art Archive cover goes through Nafyn's own cache (GET /api/v1/art/..), never straight to the archive:
// cold, the archive takes 10-20 s and the <img> would sit blank for all of it. `size` only matters for those -
// ask for the biggest only where it is shown big. Everything else (uploaded covers, other services' artwork)
// is returned as it is.
export function coverSrc(media: CoverSource | null | undefined, size?: CoverSize): string {
    if (!media) return noCover;

    if (media.hasCustomCover && media.id) return `/api/v1/library/${media.id}/cover`;
    if (media.coverMediaId) return `/api/v1/library/${media.coverMediaId}/cover`;

    return coverArtUrl(media.coverArt, size);
}

// for the places that hold a bare stored URL instead of a track (album listings, metadata cards). Without an
// explicit `size` the URL's own is kept (the album endpoint answers 500), snapped to a size the cache serves.
export function coverArtUrl(url: string | null | undefined, size?: CoverSize): string {
    if (!url) return noCover;
    const caa = CAA_FRONT.exec(url);
    if (!caa) return url;

    const own = Number(/(\d+)$/.exec(url)?.[1]);
    const wanted: CoverSize = size ?? (own === 500 || own === 1000 ? own : 250);
    return `/api/v1/art/${caa[1]!.toLowerCase()}/${caa[2]!.toLowerCase()}/${wanted}`;
}

// cache-busted variant, for right after a cover has been replaced
export function coverSrcFresh(media: CoverSource | null | undefined, version: number | string, size?: CoverSize): string {
    const src = coverSrc(media, size);
    return src.startsWith("/api/") ? `${src}?v=${version}` : src;
}

export const noCoverImage = noCover;
