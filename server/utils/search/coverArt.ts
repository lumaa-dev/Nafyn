// "Does this release have a FRONT cover?", answered with a HEAD request against the Cover Art Archive.
//
// The MusicBrainz *search* endpoints carry no `cover-art-archive` summary (only lookups and browses do), so the
// archive itself is asked: `/release/{mbid}/front` answers 307 to the image when a front cover exists and 404
// when it doesn't. The release is the one the result was judged on; when it has no front cover, the
// release-group's `/front` (which the archive resolves to any of its releases) is tried before giving up,
// because that is the image the rest of Nafyn shows for the album.
//
// Results are cached, negative ones too (shorter), so a cover-less album costs one request per day, not per search.

export type HeadFetch = (url: string, timeoutMs: number) => Promise<number | null>;

export const defaultHeadFetch: HeadFetch = async (url, timeoutMs) => {
    try {
        // redirect: "manual" - the 307 is the answer, following it would download from archive.org
        const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        return response.status;
    } catch {
        return null;
    }
};

const BASE = "https://coverartarchive.org";
const POSITIVE_TTL_MS = 7 * 24 * 60 * 60_000;
const NEGATIVE_TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 5000;

export interface CoverArtTarget {
    releaseId: string | null,
    releaseGroupId?: string | null,
    /** `cover-art-archive` summary from a lookup/browse, when the caller already has it. */
    known?: { front?: boolean, darkened?: boolean } | null
}

export class CoverArtChecker {
    private readonly cache = new Map<string, { value: boolean, expires: number }>();
    private readonly inFlight = new Map<string, Promise<boolean>>();

    constructor(
        private readonly head: HeadFetch = defaultHeadFetch,
        private readonly timeoutMs = 4000,
        private readonly now: () => number = () => Date.now()
    ) {}

    private async exists(path: string): Promise<boolean> {
        const cached = this.cache.get(path);
        if (cached && cached.expires > this.now()) return cached.value;

        let pending = this.inFlight.get(path);
        if (!pending) {
            pending = this.head(`${BASE}${path}`, this.timeoutMs)
                .then((status) => {
                    // 404 = no such image. A timeout/5xx says nothing, so it is neither cached nor trusted.
                    const found = status !== null && status >= 200 && status < 400;
                    if (status !== null && (found || status === 404)) {
                        this.cache.delete(path);
                        this.cache.set(path, { value: found, expires: this.now() + (found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
                        if (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
                    }
                    return found;
                })
                .finally(() => this.inFlight.delete(path));
            this.inFlight.set(path, pending);
        }
        return pending;
    }

    async hasFront(target: CoverArtTarget): Promise<boolean> {
        if (target.known) {
            if (target.known.front === true && target.known.darkened !== true) return true;
            if (target.known.front === false) return this.groupFront(target);
        }
        if (target.releaseId && await this.exists(`/release/${target.releaseId}/front`)) return true;
        return this.groupFront(target);
    }

    private async groupFront(target: CoverArtTarget): Promise<boolean> {
        return target.releaseGroupId ? this.exists(`/release-group/${target.releaseGroupId}/front`) : false;
    }
}
