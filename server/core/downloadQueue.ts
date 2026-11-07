// runs requests through the Soulseek/MusicBrainz pipeline one at a time; the rest wait in FIFO order
// and start as soon as the running one succeeds or fails. In-process, like downloadEvents.ts (one Nitro instance).
// The limit is fixed: no setting, no env var, no endpoint changes it.

export const MAX_CONCURRENT_DOWNLOADS = 1;

interface Waiter {
    requestId: string,
    start: () => void
}

let running = 0;
const waiting: Waiter[] = [];

function drain(): void {
    while (running < MAX_CONCURRENT_DOWNLOADS && waiting.length > 0) {
        running++;
        waiting.shift()!.start();
    }
}

/**
 * Resolves with a release function once the request may run. `onQueued` is called with the 1-based queue
 * position when it has to wait, and again whenever that position improves.
 */
export async function acquireDownloadSlot(requestId: string, onQueued?: (position: number) => void): Promise<() => void> {
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        running--;
        drain();
        notifyPositions();
    };

    if (running < MAX_CONCURRENT_DOWNLOADS && waiting.length === 0) {
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
