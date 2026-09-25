import { extname } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

export interface AudioTags {
    title: string,
    artist: string,
    album?: string | null,
    trackNumber?: number | null,
    date?: Date | null,
    label?: string | null
}

// SECURITY: every file this remuxes came from somewhere untrusted - a Soulseek peer or a user upload - and
// ffmpeg picks its demuxer by *probing the content*, not by trusting the extension. A file named .mp3 whose
// bytes are an HLS playlist (#EXTM3U) or a concat script would be opened as one, and both can pull other
// files off the local disk into the output. Pinning the demuxer to the format the extension promised makes
// ffmpeg parse the bytes as that format or fail.
const DEMUXER_BY_EXTENSION: Record<string, string> = {
    ".mp3": "mp3",
    ".flac": "flac",
    ".ogg": "ogg",
    ".wav": "wav"
};

// remuxes (no re-encode) `inputPath` into `outputPath` with fresh metadata from MusicBrainz, dropping whatever tags the source file came with
export function tagAudioFile(inputPath: string, outputPath: string, tags: AudioTags): Promise<void> {
    return new Promise((resolve, reject) => {
        const demuxer = DEMUXER_BY_EXTENSION[extname(inputPath).toLowerCase()];
        if (!demuxer) {
            reject(new Error(`Refusing to remux an unsupported audio format (${extname(inputPath)})`));
            return;
        }

        // fluent-ffmpeg only splits space-containing args when outputOptions() is called
        // with a single array argument (legacy compat mode) - passing each option as its
        // own argument (spread) disables that and keeps metadata values like "Daft Punk" intact
        const command = ffmpeg(inputPath).inputFormat(demuxer).outputOptions(
            "-map_metadata", "-1",
            "-codec", "copy",
            "-metadata", `title=${tags.title}`,
            "-metadata", `artist=${tags.artist}`
        );

        if (tags.album) command.outputOptions("-metadata", `album=${tags.album}`);
        if (tags.trackNumber) command.outputOptions("-metadata", `track=${tags.trackNumber}`);
        if (tags.date) command.outputOptions("-metadata", `date=${tags.date.toISOString().slice(0, 10)}`);
        if (tags.label) command.outputOptions("-metadata", `publisher=${tags.label}`);

        command
            .on("error", reject)
            .on("end", () => resolve())
            .save(outputPath);
    });
}
