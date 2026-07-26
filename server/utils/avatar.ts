// avatar image storage: validates + crops uploads to a fixed 250x250 webp on disk under .data/avatars/<userId>.webp
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { imageSize } from "image-size";

if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

const AVATAR_DIR = join(process.cwd(), ".data", "avatars");
const TMP_DIR = join(process.cwd(), ".data", "tmp");
const AVATAR_SIZE = 250;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["png", "jpg", "jpeg", "webp"]);

export function avatarFilePath(userId: string): string {
    return join(AVATAR_DIR, `${userId}.webp`);
}

// validates, center-crops to 250x250 and writes the avatar for `userId`, replacing any existing one
export async function saveAvatar(userId: string, buffer: Buffer): Promise<void> {
    if (buffer.length > MAX_UPLOAD_BYTES) {
        throw createError({ statusCode: 413, statusMessage: "Avatar image is too large (max 16 MB)" });
    }

    let dimensions;
    try {
        dimensions = imageSize(buffer);
    } catch {
        throw createError({ statusCode: 400, statusMessage: "Unrecognized image format" });
    }

    if (!dimensions.type || !ALLOWED_TYPES.has(dimensions.type)) {
        throw createError({ statusCode: 400, statusMessage: "Avatar must be a PNG, JPEG or WebP image" });
    }

    if (dimensions.width < AVATAR_SIZE || dimensions.height < AVATAR_SIZE) {
        throw createError({ statusCode: 400, statusMessage: `Avatar must be at least ${AVATAR_SIZE}x${AVATAR_SIZE}px` });
    }

    await mkdir(TMP_DIR, { recursive: true });
    await mkdir(AVATAR_DIR, { recursive: true });

    const tempPath = join(TMP_DIR, `${randomUUID()}.${dimensions.type}`);
    await writeFile(tempPath, buffer);

    try {
        await resizeAvatar(tempPath, avatarFilePath(userId));
    } finally {
        await rm(tempPath, { force: true });
    }
}

function resizeAvatar(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions(
                "-vf", `scale=${AVATAR_SIZE}:${AVATAR_SIZE}:force_original_aspect_ratio=increase,crop=${AVATAR_SIZE}:${AVATAR_SIZE}`,
                "-frames:v", "1"
            )
            .on("error", reject)
            .on("end", () => resolve())
            .save(outputPath);
    });
}

export async function deleteAvatar(userId: string): Promise<void> {
    await rm(avatarFilePath(userId), { force: true });
}
