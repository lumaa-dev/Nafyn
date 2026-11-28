import { RequestCancelledError } from "../utils/requestCancel";

// runs requests through the Soulseek/MusicBrainz pipeline one at a time; the rest wait in FIFO order
// and start as soon as the running one succeeds or fails. In-process, like downloadEvents.ts (one Nitro instance).
// The limit is fixed: no setting, no env var, no endpoint changes it.
//
// Between two requests there is a pause (NAFYN_DOWNLOAD_COOLDOWN_SECONDS, default 7): when the next one starts the
// moment the previous one ends, the Soulseek server throttles the burst and the throttled searches read as "nobody
// has this song", failing a whole chain of requests whose songs are fine. Only applied when someone is waiting.

export const MAX_CONCURRENT_DOWNLOADS = 1;
const DEFAULT_COOLDOWN_SECONDS = 7;

export function downloadCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.NAFYN_DOWNLOAD_COOLDOWN_SECONDS;
    if (raw === undefined || raw.trim() === "") return DEFAULT_COOLDOWN_SECONDS * 1000;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_COOLDOWN_SECONDS * 1000;
}

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
        const cooldown = downloadCooldownMs();
        if (waiting.length > 0 && cooldown > 0) {
            // the slot stays taken for the pause; a request cancelled meanwhile just leaves the queue
            const timer = setTimeout(() => {
                running--;
                drain();
                notifyPositions();
            }, cooldown);
            timer.unref?.();
            return;
        }
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
