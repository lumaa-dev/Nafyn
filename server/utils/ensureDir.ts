// Creates a folder Nafyn writes into and proves the server can actually use it.
//
// `mkdir` applies the process umask, and a bind mount (NFS/SMB, a host folder created by another user) can hand
// back a folder the server user can't write to even though its parent was. The first write into it then fails
// far from here, as a generic "not available". So the mode is set explicitly, repaired with chmod when the
// folder turns out not to be read-write-traversable, and anything still unusable fails right here, naming the
// path, the user and the mode.
import { constants } from "node:fs";
import { access, chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

const FOLDER_MODE = 0o755;
const NEEDED = constants.R_OK | constants.W_OK | constants.X_OK;

async function usable(path: string): Promise<boolean> {
    try {
        await access(path, NEEDED);
        return true;
    } catch {
        return false;
    }
}

// the nearest existing folder at or above `path` that the server can't use gets its bits back (owner only)
async function repairNearest(path: string): Promise<void> {
    for (let dir = path; ; dir = dirname(dir)) {
        if (await stat(dir).then(() => true, () => false)) {
            if (!await usable(dir)) await chmod(dir, FOLDER_MODE).catch(() => {});
            return;
        }
        if (dirname(dir) === dir) return;
    }
}

export async function ensureDir(path: string): Promise<void> {
    try {
        await mkdir(path, { recursive: true, mode: FOLDER_MODE });
    } catch (error) {
        // a parent that exists but is closed (no bits) rejects the whole mkdir
        await repairNearest(path);
        await mkdir(path, { recursive: true, mode: FOLDER_MODE }).catch(() => { throw error; });
    }
    if (await usable(path)) return;

    // owned by us but stripped of its bits by the umask: fixable. Owned by someone else: chmod throws.
    await chmod(path, FOLDER_MODE).catch(() => {});
    if (await usable(path)) return;

    const info = await stat(path).catch(() => null);
    const owner = info ? `owner ${info.uid}:${info.gid}, mode ${(info.mode & 0o777).toString(8)}` : "unreadable";
    const me = typeof process.getuid === "function" ? `uid ${process.getuid()}` : "this user";
    throw new Error(`folder ${path} is not read-write for ${me} (${owner}); delete it so Nafyn can recreate it, or fix its owner`);
}
