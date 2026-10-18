// caps how many requests run through the Soulseek/MusicBrainz pipeline at once; the rest wait in FIFO order
// and start as soon as a running one succeeds or fails. In-process, like downloadEvents.ts (one Nitro instance).
import { getSetting, setSetting } from "./appSettings";

export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 10;
const SETTING_KEY = "downloads.maxConcurrent";

interface Waiter {
    requestId: string,
    start: () => void
}

let running = 0;
const waiting: Waiter[] = [];

export async function getMaxConcurrentDownloads(): Promise<number> {
    const value = Number(await getSetting(SETTING_KEY));
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CONCURRENT_DOWNLOADS;
}

export async function setMaxConcurrentDownloads(limit: number): Promise<void> {
    await setSetting(SETTING_KEY, String(limit));
    // a raised limit frees slots for requests that are already waiting
    await drain();
}

async function drain(): Promise<void> {
    const limit = await getMaxConcurrentDownloads();
    while (running < limit && waiting.length > 0) {
        running++;
        waiting.shift()!.start();
    }
}

/**
 * Resolves with a release function once the request may run. `onQueued` is called with the 1-based queue
 * position when it has to wait, and again whenever that position improves.
 */
export async function acquireDownloadSlot(requestId: string, onQueued?: (position: number) => void): Promise<() => void> {
    const limit = await getMaxConcurrentDownloads();

    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        running--;
        void drain().then(() => notifyPositions());
    };

    if (running < limit && waiting.length === 0) {
        running++;
        return release;
    }

    return await new Promise<() => void>((resolve) => {
        const positionOf = () => waiting.findIndex((w) => w.requestId === requestId) + 1;
        positionCallbacks.set(requestId, () => onQueued?.(positionOf()));
        waiting.push({
            requestId,
            start: () => {
                positionCallbacks.delete(requestId);
                resolve(release);
            }
        });
        onQueued?.(waiting.length);
    });
}

const positionCallbacks = new Map<string, () => void>();

function notifyPositions(): void {
    for (const notify of positionCallbacks.values()) notify();
}
