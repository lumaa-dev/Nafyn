// Disk cache in front of the Cover Art Archive.
//
// The archive redirects every image to an archive.org storage node and routinely takes 10-20 s on a cold one;
// fetched straight from the browser, an <img> sits blank for that long on every page that shows it. Here each
// cover is fetched once (the download pipeline even warms it the moment a track lands), kept under
// `.data/art/`, and served from disk afterwards by GET /api/v1/art/{type}/{id}/{size}.
//
// SECURITY: callers never hand in a URL. The upstream URL is built here from a validated (type, uuid, size)
// triple, and still goes through fetchCoverArt's host allowlist and per-hop redirect check, so this adds no
// SSRF surface.
import { createReadStream } from "node:fs";
import { open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchCoverArtResult } from "./coverArt";
import { isUuid } from "./ids";
import { coverArchiveUrl, COVER_SIZES, type CoverKind, type CoverSize } from "./coverUrl";
import { ensureDir } from "./ensureDir";

export { COVER_SIZES, isCoverKind, isCoverSize, parseCoverArtUrl } from "./coverUrl";
export type { CoverKind, CoverSize } from "./coverUrl";

const CACHE_DIR = join(process.cwd(), ".data", "art");
const MAX_COVER_BYTES = 8 * 1024 * 1024;
// how long a caller waits for a cold fetch before getting "not yet"; the fetch itself keeps going and lands in
// the cache for the next request
const COLD_WAIT_MS = 8_000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const MAX_NEGATIVE_ENTRIES = 5_000;
// a transient failure (network error, 5xx) is retried once straight away, then backed off: the client re-asks on
// its own (CoverImage retries, every page reload), and each ask used to hit the archive again and log again
const TRANSIENT_RETRY_DELAY_MS = 1_500;
const FAILURE_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000];
// the archive sometimes answers a thumbnail request with the multi-megabyte original; that won't change soon
const OVERSIZE_TTL_MS = 24 * 60 * 60 * 1000;

const inFlight = new Map<string, Promise<boolean>>();
const missing = new Map<string, number>();
const failures = new Map<string, { retryAt: number, streak: number }>();
const oversize = new Map<string, number>();

export interface CachedCover {
    path: string,
    contentType: string,
    // ready-to-pipe stream
    stream: () => ReturnType<typeof createReadStream>
}

function key(kind: CoverKind, id: string, size: CoverSize): string {
    return `${kind}-${id.toLowerCase()}-${size}`;
}

function filePath(cacheKey: string): string {
    return join(CACHE_DIR, `${cacheKey}.img`);
}

function sniffContentType(bytes: Uint8Array): string {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
    return "";
}

async function cachedFileType(path: string): Promise<string | null> {
    try {
        const info = await stat(path);
        if (!info.isFile() || info.size === 0) return null;
        const handle = await open(path, "r");
        try {
            const head = new Uint8Array(12);
            await handle.read(head, 0, 12, 0);
            return sniffContentType(head) || null;
        } finally {
            await handle.close();
        }
    } catch {
        return null;
    }
}

function remember(map: Map<string, number>, cacheKey: string, ttlMs: number): void {
    if (map.size >= MAX_NEGATIVE_ENTRIES) map.delete(map.keys().next().value!);
    map.set(cacheKey, Date.now() + ttlMs);
}

function rememberMissing(cacheKey: string): void {
    remember(missing, cacheKey, NEGATIVE_TTL_MS);
}

function isRemembered(map: Map<string, number>, cacheKey: string): boolean {
    const until = map.get(cacheKey);
    if (until && until > Date.now()) return true;
    map.delete(cacheKey);
    return false;
}

function inBackoff(cacheKey: string): boolean {
    const failure = failures.get(cacheKey);
    return !!failure && failure.retryAt > Date.now();
}

function rememberFailure(cacheKey: string): number {
    if (failures.size >= MAX_NEGATIVE_ENTRIES) failures.delete(failures.keys().next().value!);
    const streak = (failures.get(cacheKey)?.streak ?? 0) + 1;
    const delay = FAILURE_BACKOFF_MS[Math.min(streak, FAILURE_BACKOFF_MS.length) - 1]!;
    failures.set(cacheKey, { retryAt: Date.now() + delay, streak });
    return streak;
}

// the next smaller thumbnail, for a size the archive only answers with a huge original
function smallerSize(size: CoverSize): CoverSize | null {
    const index = COVER_SIZES.indexOf(size);
    return index > 0 ? COVER_SIZES[index - 1]! : null;
}

async function fetchIntoCache(kind: CoverKind, id: string, size: CoverSize, cacheKey: string): Promise<boolean> {
    const url = coverArchiveUrl(kind, id, size);
    let result = await fetchCoverArtResult(url);
    if (result.kind === "error") {
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
        result = await fetchCoverArtResult(url);
    }
    if (result.kind === "missing") {
        rememberMissing(cacheKey);
        return false;
    }
    if (result.kind === "error") {
        // says nothing about whether the cover exists, so it is only backed off, never treated as missing
        const streak = rememberFailure(cacheKey);
        console.error(`[cover-art] couldn't fetch ${cacheKey}: ${result.reason} (failure ${streak}, retrying later)`);
        return false;
    }
    failures.delete(cacheKey);
    const response = result.response;

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_COVER_BYTES) {
        await response.body?.cancel().catch(() => {});
        remember(oversize, cacheKey, OVERSIZE_TTL_MS);
        console.error(`[cover-art] ${cacheKey} is ${declared} bytes, over the ${MAX_COVER_BYTES} cap; serving a smaller size instead`);
        return false;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_COVER_BYTES) {
        remember(oversize, cacheKey, OVERSIZE_TTL_MS);
        console.error(`[cover-art] ${cacheKey} is ${bytes.byteLength} bytes, over the ${MAX_COVER_BYTES} cap; serving a smaller size instead`);
        return false;
    }
    if (bytes.byteLength === 0 || !sniffContentType(bytes)) {
        console.error(`[cover-art] ${cacheKey}: upstream sent ${bytes.byteLength} bytes that aren't a usable image`);
        return false;
    }

    await ensureDir(CACHE_DIR);
    const destination = filePath(cacheKey);
    // written beside the destination and renamed in, so a reader never sees a half-written file
    const partial = `${destination}.${process.pid}.${Date.now()}.part`;
    try {
        await writeFile(partial, bytes);
        await rename(partial, destination);
    } catch (error) {
        await rm(partial, { force: true }).catch(() => {});
        throw error;
    }
    return true;
}

// starts (or joins) the single fetch for this cover
function ensureFetched(kind: CoverKind, id: string, size: CoverSize, cacheKey: string): Promise<boolean> {
    const running = inFlight.get(cacheKey);
    if (running) return running;

    const task = fetchIntoCache(kind, id, size, cacheKey)
        .catch((error) => {
            console.error(`[cover-art] couldn't cache ${cacheKey}: ${error}`);
            return false;
        })
        .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, task);
    return task;
}

// the cached cover, fetching it first when it isn't there yet. "missing" = the archive has no such cover (don't
// ask again soon); null = not available right now (still being fetched, or the archive was too slow)
export async function getCachedCover(kind: CoverKind, id: string, size: CoverSize): Promise<CachedCover | "missing" | null> {
    const cacheKey = key(kind, id, size);
    const path = filePath(cacheKey);

    const lookup = async (): Promise<CachedCover | null> => {
        const contentType = await cachedFileType(path);
        return contentType ? { path, contentType, stream: () => createReadStream(path) } : null;
    };

    const hit = await lookup();
    if (hit) return hit;

    if (isRemembered(missing, cacheKey)) return "missing";

    if (isRemembered(oversize, cacheKey)) {
        const smaller = smallerSize(size);
        if (smaller) return getCachedCover(kind, id, smaller);
        return "missing";
    }
    // the archive failed on this one a moment ago: don't ask (or log) again until the backoff is over
    if (inBackoff(cacheKey)) return null;

    const fetched = ensureFetched(kind, id, size, cacheKey);
    const ready = await Promise.race([
        fetched,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), COLD_WAIT_MS).unref?.())
    ]);
    if (ready) return lookup();
    // the fetch may have just found the original too big for this size
    if (isRemembered(oversize, cacheKey)) {
        const smaller = smallerSize(size);
        if (smaller) return getCachedCover(kind, id, smaller);
    }
    return missing.has(cacheKey) ? "missing" : null;
}

// fire-and-forget: have a cover on disk before anyone asks for it
export function warmCover(kind: CoverKind, id: string, size: CoverSize = 250): void {
    if (!isUuid(id)) return;
    const cacheKey = key(kind, id, size);
    if (missing.has(cacheKey) || oversize.has(cacheKey) || inBackoff(cacheKey)) return;
    void ensureFetched(kind, id.toLowerCase(), size, cacheKey);
}

// keeps `.data/art` under `maxBytes`, dropping the least recently written files first. Called from the hourly
// retention sweep. Returns how many files were removed.
export async function sweepCoverCache(maxBytes: number): Promise<number> {
    let names: string[];
    try {
        names = await readdir(CACHE_DIR);
    } catch {
        return 0;
    }

    const files: { path: string, size: number, mtimeMs: number }[] = [];
    let total = 0;
    for (const name of names) {
        const path = join(CACHE_DIR, name);
        try {
            const info = await stat(path);
            if (!info.isFile()) continue;
            // leftovers of an interrupted write
            if (name.endsWith(".part") && Date.now() - info.mtimeMs > 60 * 60 * 1000) {
                await rm(path, { force: true });
                continue;
            }
            files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
            total += info.size;
        } catch {
            // vanished between readdir and stat
        }
    }

    if (total <= maxBytes) return 0;

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let removed = 0;
    for (const file of files) {
        if (total <= maxBytes) break;
        await rm(file.path, { force: true });
        total -= file.size;
        removed++;
    }
    return removed;
}
