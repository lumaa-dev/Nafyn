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
    message?: string
}

const emitters = new Map<string, EventEmitter>();

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
