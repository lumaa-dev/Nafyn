// The two spellings of one Cover Art Archive cover, and the conversion between them.
//
// - archive form  `https://coverartarchive.org/release[-group]/<uuid>/front-<size>`: what is stored (media,
//   requests, subscriptions...) and what leaves the server for webhooks / APNs, which need a public absolute URL
// - Nafyn form    `/api/v1/art/<release|release-group>/<uuid>/<size>`: what every JSON response of /api/v1
//   carries (see plugins/coverArtUrls.ts), served from the disk cache of GET /api/v1/art/..
//
// Pure (no Nitro auto-imports), so it runs under `bun test`. Anything that isn't a Cover Art Archive cover
// (Deezer artwork, an uploaded cover's endpoint, null) is not touched.
import { isUuid } from "./ids";

export type CoverKind = "release" | "release-group";
export const COVER_SIZES = [250, 500, 1000] as const;
export type CoverSize = typeof COVER_SIZES[number];

export interface ParsedCover { kind: CoverKind, id: string, size: CoverSize }

const ARCHIVE_RE = /^https:\/\/coverartarchive\.org\/(release|release-group)\/([0-9a-f-]{36})\/front-(\d+)$/i;
const ART_PATH_RE = /^\/api\/v1\/art\/(release|release-group)\/([0-9a-f-]{36})\/(\d+)$/i;

export function isCoverKind(value: unknown): value is CoverKind {
    return value === "release" || value === "release-group";
}

export function isCoverSize(value: unknown): value is CoverSize {
    return typeof value === "number" && (COVER_SIZES as readonly number[]).includes(value);
}

// either spelling -> its parts, or null for anything else
export function parseCoverArtUrl(value: string): ParsedCover | null {
    const match = ARCHIVE_RE.exec(value) ?? ART_PATH_RE.exec(value);
    if (!match) return null;
    const kind = match[1]!.toLowerCase() as CoverKind;
    const id = match[2]!.toLowerCase();
    const size = Number(match[3]);
    return isUuid(id) && isCoverSize(size) ? { kind, id, size } : null;
}

export function coverArtPath(kind: CoverKind, id: string, size: CoverSize): string {
    return `/api/v1/art/${kind}/${id.toLowerCase()}/${size}`;
}

export function coverArchiveUrl(kind: CoverKind, id: string, size: CoverSize): string {
    return `https://coverartarchive.org/${kind}/${id.toLowerCase()}/front-${size}`;
}

// any spelling -> the archive form; other strings come back unchanged
export function toArchiveCoverUrl(value: string): string {
    const cover = parseCoverArtUrl(value);
    return cover ? coverArchiveUrl(cover.kind, cover.id, cover.size) : value;
}

// any spelling -> the Nafyn form; other strings come back unchanged
export function toArtPath(value: string): string {
    const cover = parseCoverArtUrl(value);
    return cover ? coverArtPath(cover.kind, cover.id, cover.size) : value;
}

// A response body with every archive-form cover URL turned into the Nafyn form. Copy-on-write: a branch with
// nothing to change is returned as the very same object (handlers may hand out objects they also cache), and
// only plain objects and arrays are walked - Dates, Buffers, streams and class instances pass through.
export function rewriteCoverUrls<T>(value: T, depth = 0): T {
    if (typeof value === "string") {
        return (value.startsWith("https://coverartarchive.org/") ? toArtPath(value) : value) as T;
    }
    if (value === null || typeof value !== "object" || depth > 24) return value;

    if (Array.isArray(value)) {
        let copy: unknown[] | null = null;
        for (let i = 0; i < value.length; i++) {
            const next = rewriteCoverUrls(value[i], depth + 1);
            if (next !== value[i]) (copy ??= value.slice())[i] = next;
        }
        return (copy ?? value) as T;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;

    let copy: Record<string, unknown> | null = null;
    for (const key of Object.keys(value)) {
        const current = (value as Record<string, unknown>)[key];
        const next = rewriteCoverUrls(current, depth + 1);
        if (next !== current) (copy ??= { ...(value as Record<string, unknown>) })[key] = next;
    }
    return (copy ?? value) as T;
}
