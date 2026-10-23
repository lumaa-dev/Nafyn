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

// Each upload spawns an ffmpeg process. Any account can upload, so concurrency is capped (a burst waits in line
// instead of forking a dozen decoders at once) and a stuck process is killed rather than kept forever.
const MAX_CONCURRENT_CROPS = 2;
const CROP_TIMEOUT_MS = 15_000;
let runningCrops = 0;
const waitingCrops: (() => void)[] = [];

async function acquireCropSlot(): Promise<() => void> {
    if (runningCrops >= MAX_CONCURRENT_CROPS) {
        await new Promise<void>((resolve) => waitingCrops.push(resolve));
    } else {
        runningCrops++;
    }
    // a waiter inherits the slot of whoever released it, so the count only drops when nobody is waiting
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next = waitingCrops.shift();
        if (next) next();
        else runningCrops--;
    };
}

export async function squareCropImage(inputPath: string, outputPath: string, size: number, type: string): Promise<void> {
    const demuxer = DEMUXER_BY_TYPE[type];
    if (!demuxer) {
        return Promise.reject(createError({ statusCode: 400, statusMessage: "Image must be a PNG, JPEG or WebP image" }));
    }

    const release = await acquireCropSlot();
    try {
        await new Promise<void>((resolve, reject) => {
            const command = ffmpeg(inputPath)
                .inputFormat(demuxer)
                .outputOptions(
                    "-vf", `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`,
                    "-frames:v", "1"
                );
            const timer = setTimeout(() => {
                command.kill("SIGKILL");
                reject(createError({ statusCode: 422, statusMessage: "The image took too long to process" }));
            }, CROP_TIMEOUT_MS);
            command
                .on("error", (error) => { clearTimeout(timer); reject(error); })
                .on("end", () => { clearTimeout(timer); resolve(); })
                .save(outputPath);
        });
    } finally {
        release();
    }
}
