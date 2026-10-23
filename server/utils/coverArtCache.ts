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
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchCoverArtResult } from "./coverArt";
import { isUuid } from "./ids";

export type CoverKind = "release" | "release-group";
export const COVER_SIZES = [250, 500, 1000] as const;
export type CoverSize = typeof COVER_SIZES[number];

const CACHE_DIR = join(process.cwd(), ".data", "art");
const MAX_COVER_BYTES = 8 * 1024 * 1024;
// how long a caller waits for a cold fetch before getting "not yet"; the fetch itself keeps going and lands in
// the cache for the next request
const COLD_WAIT_MS = 8_000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
const MAX_NEGATIVE_ENTRIES = 5_000;

const inFlight = new Map<string, Promise<boolean>>();
const missing = new Map<string, number>();

export interface CachedCover {
    path: string,
    contentType: string,
    // ready-to-pipe stream
    stream: () => ReturnType<typeof createReadStream>
}

export function isCoverKind(value: unknown): value is CoverKind {
    return value === "release" || value === "release-group";
}

export function isCoverSize(value: unknown): value is CoverSize {
    return typeof value === "number" && (COVER_SIZES as readonly number[]).includes(value);
}

// the stored form of a Cover Art Archive URL, `https://coverartarchive.org/release/<id>/front-250`, or null for
// anything else (Deezer artwork, uploaded covers, ...)
export function parseCoverArtUrl(rawUrl: string): { kind: CoverKind, id: string, size: CoverSize } | null {
    const match = /^https:\/\/coverartarchive\.org\/(release|release-group)\/([0-9a-f-]{36})\/front-(\d+)$/i.exec(rawUrl);
    if (!match) return null;
    const kind = match[1]!.toLowerCase() as CoverKind;
    const id = match[2]!.toLowerCase();
    const size = Number(match[3]);
    return isUuid(id) && isCoverSize(size) ? { kind, id, size } : null;
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

function rememberMissing(cacheKey: string): void {
    if (missing.size >= MAX_NEGATIVE_ENTRIES) missing.delete(missing.keys().next().value!);
    missing.set(cacheKey, Date.now() + NEGATIVE_TTL_MS);
}

async function fetchIntoCache(kind: CoverKind, id: string, size: CoverSize, cacheKey: string): Promise<boolean> {
    const result = await fetchCoverArtResult(`https://coverartarchive.org/${kind}/${id}/front-${size}`);
    if (result.kind === "missing") {
        rememberMissing(cacheKey);
        return false;
    }
    if (result.kind === "error") {
        // not remembered: a timeout or a 5xx says nothing about whether the cover exists
        console.error(`[cover-art] couldn't fetch ${cacheKey}: ${result.reason}`);
        return false;
    }
    const response = result.response;

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_COVER_BYTES) {
        console.error(`[cover-art] ${cacheKey} is ${declared} bytes, over the ${MAX_COVER_BYTES} cap`);
        return false;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_COVER_BYTES || !sniffContentType(bytes)) {
        console.error(`[cover-art] ${cacheKey}: upstream sent ${bytes.byteLength} bytes that aren't a usable image`);
        return false;
    }

    await mkdir(CACHE_DIR, { recursive: true });
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

    const retryAt = missing.get(cacheKey);
    if (retryAt && retryAt > Date.now()) return "missing";
    missing.delete(cacheKey);

    const fetched = ensureFetched(kind, id, size, cacheKey);
    const ready = await Promise.race([
        fetched,
        new Promise<false>((resolve) => setTimeout(() => resolve(false), COLD_WAIT_MS).unref?.())
    ]);
    if (ready) return lookup();
    return missing.has(cacheKey) ? "missing" : null;
}

// fire-and-forget: have a cover on disk before anyone asks for it
export function warmCover(kind: CoverKind, id: string, size: CoverSize = 250): void {
    if (!isUuid(id)) return;
    const cacheKey = key(kind, id, size);
    if (missing.has(cacheKey)) return;
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
