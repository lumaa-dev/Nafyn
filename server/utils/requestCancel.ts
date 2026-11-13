// Cancelling a request the pipeline is working on (POST /api/v1/request/{id}/cancel). In-process, like
// downloadEvents.ts and downloadQueue.ts: the pipeline registers an AbortController per request while it holds it,
// and the cancel route aborts it. The pipeline checks the signal between steps (and the Soulseek transfer poll
// checks it every second), throws RequestCancelledError, takes back out whatever the request added to the library
// and lands the request on "cancelled".
//
// Pure: no Nitro auto-imports.

export class RequestCancelledError extends Error {
    constructor() {
        super("Request cancelled");
        this.name = "RequestCancelledError";
    }
}

export function isRequestCancelled(error: unknown): error is RequestCancelledError {
    return error instanceof RequestCancelledError;
}

const controllers = new Map<string, AbortController>();

/** The signal the pipeline watches for this request; registered for as long as it holds the request. */
export function registerCancellable(requestId: string): AbortSignal {
    const existing = controllers.get(requestId);
    if (existing) return existing.signal;
    const controller = new AbortController();
    controllers.set(requestId, controller);
    return controller.signal;
}

export function unregisterCancellable(requestId: string): void {
    controllers.delete(requestId);
}

/** True when this process is running (or queueing) the request and was told to stop. */
export function signalCancel(requestId: string): boolean {
    const controller = controllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
}

export function isCancellable(requestId: string): boolean {
    return controllers.has(requestId);
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new RequestCancelledError();
}

/** setTimeout as a promise that rejects with RequestCancelledError as soon as `signal` aborts. */
export function cancellableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
    if (signal.aborted) return Promise.reject(new RequestCancelledError());
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new RequestCancelledError());
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
