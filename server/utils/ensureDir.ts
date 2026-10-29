// Creates a folder Nafyn writes into and proves the server can actually use it.
//
// `mkdir` applies the process umask, and a bind mount (NFS/SMB, a host folder created by another user) can hand
// back a folder the server user can't write to even though its parent was. The first write into it then fails
// far from here, as a generic "not available". So the mode is set explicitly, repaired with chmod when the
// folder turns out not to be read-write-traversable, and anything still unusable fails right here, naming the
// path, the user and the mode.
import { accessSync, chmodSync, constants, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const FOLDER_MODE = 0o755;
const NEEDED = constants.R_OK | constants.W_OK | constants.X_OK;

function usable(path: string): boolean {
    try {
        accessSync(path, NEEDED);
        return true;
    } catch {
        return false;
    }
}

function exists(path: string): boolean {
    try {
        statSync(path);
        return true;
    } catch {
        return false;
    }
}

function tryChmod(path: string): void {
    try {
        chmodSync(path, FOLDER_MODE);
    } catch {
        // not ours to change: the caller reports it
    }
}

// the nearest existing folder at or above `path` that the server can't use gets its bits back (owner only)
function repairNearest(path: string): void {
    for (let dir = path; ; dir = dirname(dir)) {
        if (exists(dir)) {
            if (!usable(dir)) tryChmod(dir);
            return;
        }
        if (dirname(dir) === dir) return;
    }
}

// Sync because libraryFilePath() reserves a file name right after making the folder, and that open is where an
// unusable folder used to surface as a bare "EACCES: permission denied, open '.../music/<album>/<title>.flac'".
export function ensureDirSync(path: string): void {
    try {
        mkdirSync(path, { recursive: true, mode: FOLDER_MODE });
    } catch (error) {
        // a parent that exists but is closed (no bits) rejects the whole mkdir
        repairNearest(path);
        try {
            mkdirSync(path, { recursive: true, mode: FOLDER_MODE });
        } catch {
            throw error;
        }
    }
    if (usable(path)) return;

    // owned by us but stripped of its bits by the umask: fixable. Owned by someone else: chmod throws.
    tryChmod(path);
    if (usable(path)) return;

    let info: ReturnType<typeof statSync> | null = null;
    try {
        info = statSync(path);
    } catch {
        // reported as unreadable below
    }
    const owner = info ? `owner ${info.uid}:${info.gid}, mode ${(info.mode & 0o777).toString(8)}` : "unreadable";
    const me = typeof process.getuid === "function" ? `uid ${process.getuid()}` : "this user";
    throw new Error(`folder ${path} is not read-write for ${me} (${owner}); delete it so Nafyn can recreate it, or fix its owner`);
}

export async function ensureDir(path: string): Promise<void> {
    ensureDirSync(path);
}
