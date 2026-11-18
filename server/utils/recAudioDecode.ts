// decodes audio to mono 22.05 kHz float PCM with the bundled ffmpeg, for the recommender's audio analysis.
//
// SECURITY: the same rule as audioTag.ts - ffmpeg is never left to probe the input format, because a file
// whose bytes are a playlist or a concat script would be opened as one and could pull other local files in.
// The demuxer is pinned from the extension (files) or to MP4/AAC (iTunes previews, which only come from
// Apple's hosts, see trackPreview.ts).
import { spawn } from "node:child_process";
import { extname } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { SAMPLE_RATE } from "./recommender/mixes/audio";

const DEMUXER_BY_EXTENSION: Record<string, string> = {
    ".mp3": "mp3",
    ".flac": "flac",
    ".ogg": "ogg",
    ".opus": "ogg",
    ".wav": "wav",
    ".m4a": "mov",
    ".aac": "aac"
};

const MAX_SECONDS = 45;
const TIMEOUT_MS = 30_000;

function run(args: string[], input: Uint8Array | null): Promise<Float32Array | null> {
    return new Promise((resolve) => {
        if (!ffmpegPath) return resolve(null);
        const child = spawn(ffmpegPath as unknown as string, args, { stdio: [input ? "pipe" : "ignore", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        let size = 0;
        const limit = SAMPLE_RATE * 4 * (MAX_SECONDS + 1);
        const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
        child.stdout!.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= limit) chunks.push(c);
        });
        child.on("error", () => {
            clearTimeout(timer);
            resolve(null);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0 && size === 0) return resolve(null);
            const buf = Buffer.concat(chunks);
            const usable = buf.byteLength - (buf.byteLength % 4);
            const copy = new Uint8Array(usable);
            copy.set(buf.subarray(0, usable));
            resolve(new Float32Array(copy.buffer));
        });
        if (input) {
            child.stdin!.on("error", () => {});
            child.stdin!.end(Buffer.from(input));
        }
    });
}

function outputArgs(): string[] {
    return ["-t", String(MAX_SECONDS), "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"];
}

/**
 * Up to 45 s of a library file, from 30 s in (past most intros) - or from the start for a short track, in
 * which case ffmpeg simply returns less.
 */
export async function decodeFile(path: string, durationSeconds: number | null): Promise<Float32Array | null> {
    const demuxer = DEMUXER_BY_EXTENSION[extname(path).toLowerCase()];
    if (!demuxer) return null;
    const start = durationSeconds && durationSeconds > 90 ? 30 : 0;
    return await run(["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(start), "-f", demuxer, "-i", path, ...outputArgs()], null);
}

/** a 30-second iTunes preview (MP4/AAC bytes) */
export async function decodePreview(bytes: Uint8Array): Promise<Float32Array | null> {
    return await run(["-hide_banner", "-loglevel", "error", "-f", "mov", "-i", "pipe:0", ...outputArgs()], bytes);
}
