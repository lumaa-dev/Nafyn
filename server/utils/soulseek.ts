// thin HTTP client for a self-hosted slskd instance (https://github.com/slskd/slskd), kept as anonymous as
// the protocol allows:
// - what gets shared back to the Soulseek network is entirely slskd's own configuration, outside this app's control
// - credentials only ever come from server-side env, never logged or echoed back to callers
//
// slskd's REST API can drive searches and downloads, but has no endpoint that streams a finished download's
// bytes back over HTTP - it expects the caller to read the file straight off disk (same pattern used by
// Sonarr/Lidarr-style integrations). `SOULSEEK_DOWNLOADS_PATH` must point at a local, readable mount of slskd's
// own downloads directory (e.g. an SMB/NFS share) so the last step of a download - copying the finished file
// into this app's own storage - can actually happen.

import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SlskSearchResult {
    user: string,
    file: string,
    size: number,
    slots: boolean,
    bitrate?: number,
    speed?: number
}

export interface DownloadProgress {
    bytesDownloaded: number,
    totalBytes: number,
    speedBytesPerSec: number,
    etaSeconds: number | null
}

interface SlskdConfig {
    host: string,
    username: string,
    password: string,
    downloadsPath: string
}

function getConfig(): SlskdConfig {
    const config = useRuntimeConfig();
    if (!config.soulseekHost || !config.soulseekUsername || !config.soulseekPassword) {
        throw createError({ statusCode: 500, statusMessage: "Soulseek (slskd) connection is not configured" });
    }
    return {
        host: config.soulseekHost.replace(/\/+$/, ""),
        username: config.soulseekUsername,
        password: config.soulseekPassword,
        downloadsPath: config.soulseekDownloadsPath
    };
}

interface TokenState {
    token: string,
    expiresAtMs: number
}

let tokenState: TokenState | null = null;

async function getToken(): Promise<string> {
    const { host, username, password } = getConfig();

    if (tokenState && tokenState.expiresAtMs > Date.now() + 10_000) {
        return tokenState.token;
    }

    const res = await fetch(`${host}/api/v0/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
        throw new Error(`Failed to authenticate with slskd (status ${res.status})`);
    }

    const data = await res.json() as { token: string, expires: number };
    tokenState = { token: data.token, expiresAtMs: data.expires * 1000 };
    return tokenState.token;
}

// attaches the bearer token to every call, retries once after a fresh login on 401
async function slskdFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const { host } = getConfig();
    const token = await getToken();

    const res = await fetch(`${host}${path}`, {
        ...init,
        headers: {
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            Authorization: `Bearer ${token}`,
            ...init.headers
        }
    });

    if (res.status === 401 && retry) {
        tokenState = null;
        return slskdFetch(path, init, false);
    }

    return res;
}

interface SlskdFile {
    filename: string,
    size: number,
    bitRate?: number
}

interface SlskdResponse {
    username: string,
    hasFreeUploadSlot: boolean,
    uploadSpeed: number,
    files: SlskdFile[]
}

interface SlskdSearch {
    isComplete: boolean
}

export async function searchSoulseek(query: string, timeoutMs = 20000): Promise<SlskSearchResult[]> {
    const id = randomUUID();
    const searchTimeoutSeconds = Math.max(5, Math.round(timeoutMs / 1000));

    const startRes = await slskdFetch("/api/v0/searches", {
        method: "POST",
        body: JSON.stringify({ id, searchText: query })
    });

    if (!startRes.ok) {
        throw new Error(`Failed to start Soulseek search (status ${startRes.status})`);
    }

    const deadline = Date.now() + timeoutMs + 5000;
    while (Date.now() < deadline) {
        const stateRes = await slskdFetch(`/api/v0/searches/${id}`);
        if (stateRes.ok) {
            const state = await stateRes.json() as SlskdSearch;
            if (state.isComplete) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const responsesRes = await slskdFetch(`/api/v0/searches/${id}/responses`);
    const responses = responsesRes.ok ? await responsesRes.json() as SlskdResponse[] : [];

    console.log(`[soulseek] ${responses.length} results for ${query} (${id})`);

    // slskdFetch(`/api/v0/searches/${id}`, { method: "DELETE" }).catch(() => {});

    return responses.flatMap((response) =>
        response.files.map((file) => ({
            user: response.username,
            file: file.filename,
            size: file.size,
            slots: response.hasFreeUploadSlot,
            bitrate: file.bitRate,
            speed: response.uploadSpeed
        }))
    );
}

interface SlskdTransfer {
    id: string,
    filename: string,
    size: number,
    state: string,
    bytesTransferred: number
}

interface SlskdEnqueueResponse {
    enqueued: SlskdTransfer[],
    failed: { filename: string, message: string }[]
}

interface SlskdFilesystemEntry {
    name: string,
    fullName: string,
    length?: number,
    files?: SlskdFilesystemEntry[]
}

// slskd's recursive listing flattens everything into the *root* entry's `files` array - each file's
// `fullName` already carries its path relative to the downloads root (subdirectory entries in `directories`
// are not populated), so a plain scan of `files` + splitting `fullName` is all that's needed
function findInTree(entry: SlskdFilesystemEntry, name: string, size: number): string[] | null {
    for (const file of entry.files ?? []) {
        if (file.name === name && file.length === size) {
            return file.fullName.replace(/\\/g, "/").split("/").filter(Boolean);
        }
    }
    return null;
}

async function locateDownloadedFile(filename: string, size: number): Promise<string[] | null> {
    const res = await slskdFetch("/api/v0/files/downloads/directories?recursive=true");
    if (!res.ok) return null;

    const tree = await res.json() as SlskdFilesystemEntry | SlskdFilesystemEntry[];
    const roots = Array.isArray(tree) ? tree : [tree];

    for (const root of roots) {
        const found = findInTree(root, filename, size);
        if (found) return found;
    }
    return null;
}

// enqueues a download through slskd, polls until it finishes, then copies the finished file off the shared
// downloads mount into `destPath`; the peer-supplied filename is never trusted for anything beyond locating
// the file slskd itself already validated and saved
export async function downloadFromSoulseek(
    file: SlskSearchResult,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
    const { downloadsPath } = getConfig();
    if (!downloadsPath) {
        throw createError({ statusCode: 500, statusMessage: "SOULSEEK_DOWNLOADS_PATH is not configured" });
    }

    const remoteBasename = file.file.replace(/\\/g, "/").split("/").pop() ?? file.file;

    const enqueueRes = await slskdFetch(`/api/v0/transfers/downloads/${encodeURIComponent(file.user)}`, {
        method: "POST",
        body: JSON.stringify([{ filename: file.file, size: file.size }])
    });

    if (!enqueueRes.ok) {
        throw new Error(`Failed to enqueue Soulseek download (status ${enqueueRes.status})`);
    }

    const { enqueued, failed } = await enqueueRes.json() as SlskdEnqueueResponse;
    const transfer = enqueued.find((t) => t.filename === file.file);

    if (!transfer) {
        const reason = failed.find((f) => f.filename === file.file)?.message ?? "not enqueued";
        throw new Error(`Soulseek download rejected: ${reason}`);
    }

    let lastBytes = 0;
    let lastTick = Date.now();
    let finalState = transfer.state;

    // poll until the transfer reaches a terminal (Completed-flagged) state
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const pollRes = await slskdFetch(`/api/v0/transfers/downloads/${encodeURIComponent(file.user)}/${transfer.id}`);
        if (!pollRes.ok) continue;

        const current = await pollRes.json() as SlskdTransfer;
        finalState = current.state;

        const now = Date.now();
        const elapsed = (now - lastTick) / 1000;
        if (elapsed >= 1 && onProgress) {
            const speedBytesPerSec = (current.bytesTransferred - lastBytes) / elapsed;
            const remaining = current.size - current.bytesTransferred;
            onProgress({
                bytesDownloaded: current.bytesTransferred,
                totalBytes: current.size,
                speedBytesPerSec,
                etaSeconds: speedBytesPerSec > 0 ? Math.round(remaining / speedBytesPerSec) : null
            });
            lastTick = now;
            lastBytes = current.bytesTransferred;
        }

        if (current.state.includes("Completed")) break;
    }

    if (!finalState.includes("Succeeded")) {
        throw new Error(`Soulseek transfer ended in state: ${finalState}`);
    }

    // the transfer succeeded, but slskd only exposes the result on disk - find it on the shared mount and copy it in
    let relativeSegments: string[] | null = null;
    for (let attempt = 0; attempt < 5 && !relativeSegments; attempt++) {
        relativeSegments = await locateDownloadedFile(remoteBasename, file.size);
        if (!relativeSegments) await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!relativeSegments) {
        throw new Error("Soulseek transfer succeeded but the file couldn't be located on the shared downloads mount");
    }

    const sourcePath = join(downloadsPath, ...relativeSegments);

    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(sourcePath, destPath);

    onProgress?.({ bytesDownloaded: file.size, totalBytes: file.size, speedBytesPerSec: 0, etaSeconds: 0 });
}
