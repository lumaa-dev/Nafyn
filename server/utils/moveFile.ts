// Moves a file, also across filesystems. `rename()` is atomic but fails with EXDEV when the two paths are on
// different devices - which is the normal case in Docker, where `.data` and `music` are separate bind mounts.
// The fallback copies next to the destination first and renames *there* (same device, so atomic): a reader of
// the destination never sees a half-written file, and a crash leaves at worst a `.part` file beside it.
import { copyFile, rename, rm } from "node:fs/promises";

export async function moveFile(source: string, destination: string): Promise<void> {
    try {
        await rename(source, destination);
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    }

    const partial = `${destination}.part`;
    try {
        await copyFile(source, partial);
        await rename(partial, destination);
    } catch (error) {
        await rm(partial, { force: true }).catch(() => {});
        throw error;
    }
    await rm(source, { force: true });
}
