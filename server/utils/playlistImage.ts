// playlist cover image storage: validates + crops uploads to a fixed 500x500 webp on disk under .data/playlists/<playlistId>.webp
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { imageSize } from "image-size";
import { assertUuid } from "./ids";
import { assertSafeImageDimensions, squareCropImage } from "./imageUpload";

const PLAYLIST_IMAGE_DIR = join(process.cwd(), ".data", "playlists");
const TMP_DIR = join(process.cwd(), ".data", "tmp");
const PLAYLIST_IMAGE_SIZE = 500;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["png", "jpg", "jpeg", "webp"]);

// SECURITY: same reasoning as avatarFilePath - `playlistId` arrives from a route param and, via Subsonic's
// getCoverArt `pl-<id>` form, from a query param. Requiring the UUID shape stops `../` traversal reads.
export function playlistImageFilePath(playlistId: string): string {
    assertUuid(playlistId, "playlist ID");

    const path = resolve(PLAYLIST_IMAGE_DIR, `${playlistId}.webp`);
    if (!path.startsWith(resolve(PLAYLIST_IMAGE_DIR) + sep)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid playlist ID" });
    }
    return path;
}

// validates, center-crops to 500x500 and writes the cover image for `playlistId`, replacing any existing one
export async function savePlaylistImage(playlistId: string, buffer: Buffer): Promise<void> {
    if (buffer.length > MAX_UPLOAD_BYTES) {
        throw createError({ statusCode: 413, statusMessage: "Playlist image is too large (max 16 MB)" });
    }

    let dimensions;
    try {
        dimensions = imageSize(buffer);
    } catch {
        throw createError({ statusCode: 400, statusMessage: "Unrecognized image format" });
    }

    if (!dimensions.type || !ALLOWED_TYPES.has(dimensions.type)) {
        throw createError({ statusCode: 400, statusMessage: "Playlist image must be a PNG, JPEG or WebP image" });
    }

    assertSafeImageDimensions(dimensions.width, dimensions.height);

    if (dimensions.width < PLAYLIST_IMAGE_SIZE || dimensions.height < PLAYLIST_IMAGE_SIZE) {
        throw createError({ statusCode: 400, statusMessage: `Playlist image must be at least ${PLAYLIST_IMAGE_SIZE}x${PLAYLIST_IMAGE_SIZE}px` });
    }

    await mkdir(TMP_DIR, { recursive: true });
    await mkdir(PLAYLIST_IMAGE_DIR, { recursive: true });

    const tempPath = join(TMP_DIR, `${randomUUID()}.${dimensions.type}`);
    await writeFile(tempPath, buffer);

    try {
        await squareCropImage(tempPath, playlistImageFilePath(playlistId), PLAYLIST_IMAGE_SIZE, dimensions.type);
    } finally {
        await rm(tempPath, { force: true });
    }
}

export async function deletePlaylistImage(playlistId: string): Promise<void> {
    await rm(playlistImageFilePath(playlistId), { force: true });
}
