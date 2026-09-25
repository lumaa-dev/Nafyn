// custom cover art storage: validates + crops uploads to a fixed 500x500 webp on disk under .data/covers/<mediaId>.webp
//
// `media.coverArt` stays what it has always been: a Cover Art Archive URL, fetched server-side by Subsonic's
// getCoverArt and therefore constrained by the allowlist in utils/coverArt.ts. A cover a user uploads never
// goes through that column - it lands on disk, `media.hasCustomCover` is flipped, and every reader prefers
// the local file. That keeps user input out of the one field that becomes a server-side fetch (SSRF).
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { imageSize } from "image-size";
import { assertUuid } from "./ids";
import { assertSafeImageDimensions, squareCropImage } from "./imageUpload";

const COVER_DIR = join(process.cwd(), ".data", "covers");
const TMP_DIR = join(process.cwd(), ".data", "tmp");
const COVER_SIZE = 500;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["png", "jpg", "jpeg", "webp"]);

// SECURITY: same reasoning as avatarFilePath/playlistImageFilePath - `mediaId` arrives from a route param
// and, via Subsonic's getCoverArt `mf-<id>` form, from a query param. Requiring the UUID shape stops `../`
// traversal; the resolve() containment check backs it up.
export function mediaCoverFilePath(mediaId: string): string {
    assertUuid(mediaId, "media ID");

    const path = resolve(COVER_DIR, `${mediaId}.webp`);
    if (!path.startsWith(resolve(COVER_DIR) + sep)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid media ID" });
    }
    return path;
}

// validates, center-crops to 500x500 and writes the cover for `mediaId`, replacing any existing one
export async function saveMediaCover(mediaId: string, buffer: Buffer): Promise<void> {
    if (buffer.length > MAX_UPLOAD_BYTES) {
        throw createError({ statusCode: 413, statusMessage: "Cover image is too large (max 16 MB)" });
    }

    let dimensions;
    try {
        dimensions = imageSize(buffer);
    } catch {
        throw createError({ statusCode: 400, statusMessage: "Unrecognized image format" });
    }

    if (!dimensions.type || !ALLOWED_TYPES.has(dimensions.type)) {
        throw createError({ statusCode: 400, statusMessage: "Cover must be a PNG, JPEG or WebP image" });
    }

    assertSafeImageDimensions(dimensions.width, dimensions.height);

    await mkdir(TMP_DIR, { recursive: true });
    await mkdir(COVER_DIR, { recursive: true });

    const tempPath = join(TMP_DIR, `${randomUUID()}.${dimensions.type}`);
    await writeFile(tempPath, buffer);

    try {
        await squareCropImage(tempPath, mediaCoverFilePath(mediaId), COVER_SIZE, dimensions.type);
    } finally {
        await rm(tempPath, { force: true });
    }
}

export async function deleteMediaCover(mediaId: string): Promise<void> {
    // called from the library-deletion path too, where a non-UUID id would throw rather than no-op
    if (!/^[0-9a-f-]{36}$/i.test(mediaId)) return;
    await rm(mediaCoverFilePath(mediaId), { force: true }).catch(() => {});
}
