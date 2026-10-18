// pub/sub for download progress, consumed by the `ws/downloads` route so clients can watch a request live
import { EventEmitter } from "node:events";

export type DownloadStage = "searching" | "downloading" | "processing" | "completed" | "failed";

export interface DownloadProgressEvent {
    requestId: string,
    stage: DownloadStage,
    trackTitle?: string,
    trackIndex?: number,
    trackCount?: number,
    bytesDownloaded?: number,
    totalBytes?: number,
    speedBytesPerSec?: number,
    etaSeconds?: number | null,
    message?: string,
    // set when this event reports one track of a multi-track request ending; `stage` stays non-terminal
    trackResult?: "completed" | "failed"
}

const emitters = new Map<string, EventEmitter>();
// request-agnostic listeners (push notifications follow every request, not one requestId)
const globalListeners = new Set<(event: DownloadProgressEvent) => void>();

function getEmitter(requestId: string): EventEmitter {
    let emitter = emitters.get(requestId);
    if (!emitter) {
        emitter = new EventEmitter();
        emitters.set(requestId, emitter);
    }
    return emitter;
}

export function emitDownloadProgress(event: DownloadProgressEvent): void {
    console.log(`[downloadEvents] ${event.stage} > ${event.message ?? "No message..."} (${event.bytesDownloaded ?? 0}/${event.totalBytes ?? 0})`);
    
    getEmitter(event.requestId).emit("progress", event);
    for (const listener of globalListeners) {
        try {
            listener(event);
        } catch (err) {
            console.error("[downloadEvents] global listener failed:", err);
        }
    }
}

/** listens to progress of every request; returns an unsubscribe */
export function onAnyDownloadProgress(listener: (event: DownloadProgressEvent) => void): () => void {
    globalListeners.add(listener);
    return () => globalListeners.delete(listener);
}

export function onDownloadProgress(requestId: string, listener: (event: DownloadProgressEvent) => void): () => void {
    const emitter = getEmitter(requestId);
    emitter.on("progress", listener);
    return () => emitter.off("progress", listener);
}

// call once a request reaches "completed"/"failed" so the emitter doesn't leak forever
export function clearDownloadEmitter(requestId: string): void {
    emitters.delete(requestId);
}
