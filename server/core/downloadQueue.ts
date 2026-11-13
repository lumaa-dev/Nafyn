import { RequestCancelledError } from "../utils/requestCancel";

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
/**
 * A request cancelled while it waits (`signal` aborted) leaves the queue: the promise rejects with
 * RequestCancelledError and never takes a slot.
 */
export async function acquireDownloadSlot(requestId: string, onQueued?: (position: number) => void, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new RequestCancelledError();
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

    return await new Promise<() => void>((resolve, reject) => {
        const positionOf = () => waiting.findIndex((w) => w.requestId === requestId) + 1;
        const onAbort = () => {
            const index = waiting.findIndex((w) => w.requestId === requestId);
            if (index === -1) return;
            waiting.splice(index, 1);
            positionCallbacks.delete(requestId);
            notifyPositions();
            reject(new RequestCancelledError());
        };
        positionCallbacks.set(requestId, () => onQueued?.(positionOf()));
        waiting.push({
            requestId,
            start: () => {
                signal?.removeEventListener("abort", onAbort);
                positionCallbacks.delete(requestId);
                resolve(release);
            }
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        onQueued?.(waiting.length);
    });
}

const positionCallbacks = new Map<string, () => void>();

function notifyPositions(): void {
    for (const notify of positionCallbacks.values()) notify();
}
