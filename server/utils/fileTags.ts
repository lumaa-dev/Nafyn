// The title and artist tags of an audio file, as they came with it. Best effort: an unreadable file has none.
import type { FileTags } from "./tagEvidence";

export async function readFileTags(filePath: string): Promise<FileTags> {
    try {
        const { parseFile } = await import("music-metadata");
        const { common } = await parseFile(filePath, { duration: false, skipCovers: true });
        return { title: common.title ?? null, artist: common.artist ?? common.albumartist ?? null };
    } catch {
        return {};
    }
}
