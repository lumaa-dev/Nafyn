// shared ffmpeg step behind every user-uploaded image (avatars, playlist covers, track covers): center-crop to
// a square and write it out as webp.
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

// SECURITY: a PNG/WebP header can declare enormous dimensions in a file of a few kilobytes. image-size only
// reads that header, so the upload passes the byte-size cap, and it's ffmpeg that then allocates a frame of
// width x height pixels while decoding - a 60000x60000 image is ~14 GB of RGBA. Refuse the dimensions before
// anything gets decoded. The ceiling is still far above any real photo or cover scan.
const MAX_IMAGE_EDGE = 12_000;
const MAX_IMAGE_PIXELS = 50_000_000;

// SECURITY: ffmpeg picks its demuxer by probing the bytes, not by trusting the extension. Pinning it to the
// format image-size already recognized means the file is decoded as that image format or not at all, rather
// than as whatever else (a playlist, a concat script, ...) the uploader managed to make it look like.
const DEMUXER_BY_TYPE: Record<string, string> = {
    png: "png_pipe",
    jpg: "jpeg_pipe",
    jpeg: "jpeg_pipe",
    webp: "webp_pipe"
};

export function assertSafeImageDimensions(width: number | undefined, height: number | undefined): void {
    if (!width || !height || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) {
        throw createError({ statusCode: 400, statusMessage: `Image dimensions must be at most ${MAX_IMAGE_EDGE}x${MAX_IMAGE_EDGE}px` });
    }
}

export function squareCropImage(inputPath: string, outputPath: string, size: number, type: string): Promise<void> {
    const demuxer = DEMUXER_BY_TYPE[type];
    if (!demuxer) {
        return Promise.reject(createError({ statusCode: 400, statusMessage: "Image must be a PNG, JPEG or WebP image" }));
    }

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .inputFormat(demuxer)
            .outputOptions(
                "-vf", `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`,
                "-frames:v", "1"
            )
            .on("error", reject)
            .on("end", () => resolve())
            .save(outputPath);
    });
}
