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

export function coverSrc(media: CoverSource | null | undefined): string {
    if (!media) return noCover;

    if (media.hasCustomCover && media.id) return `/api/v1/library/${media.id}/cover`;
    if (media.coverMediaId) return `/api/v1/library/${media.coverMediaId}/cover`;

    return media.coverArt ?? noCover;
}

// cache-busted variant, for right after a cover has been replaced
export function coverSrcFresh(media: CoverSource | null | undefined, version: number | string): string {
    const src = coverSrc(media);
    return src.startsWith("/api/") ? `${src}?v=${version}` : src;
}

export const noCoverImage = noCover;
