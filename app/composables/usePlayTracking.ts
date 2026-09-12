// client-side capture and delivery of play events for "Your Music Year".
//
// Split out of usePlayer.ts on purpose: the player owns *when* a listen starts and stops, this owns what
// happens to that fact afterwards - queueing it, surviving a refresh or an offline spell, and eventually
// getting it to POST /api/v1/insights/events.
//
// Nothing here runs on the server. usePlayer is imported by SSR-rendered pages, so every localStorage,
// navigator and window access is behind an import.meta.client guard and a try/catch (Safari in private mode
// throws outright on setItem).

export type PlaySource = "library" | "playlist" | "album" | "track";

export interface QueuedPlayEvent {
    event_id: string,
    track_id: string,
    playlist_id: string | null,
    started_at: number,
    duration_ms: number,
    completed: boolean,
    source: PlaySource
}

const STORAGE_KEY = "nafyn.playEvents.v1";
const ENDPOINT = "/api/v1/insights/events";

// the server takes 50 per request; the local queue holds ten flushes' worth before it starts dropping the
// oldest, which is far more than an offline session realistically produces
const MAX_QUEUED = 500;
const MAX_PER_FLUSH = 50;
const FLUSH_INTERVAL_MS = 30_000;

// --- opt-in state ------------------------------------------------------------------------------------
//
// Tri-state, and module-level rather than `useState`, for two reasons that between them caused every play
// to be silently dropped before:
//
//   1. "unknown" is a distinct state from "disabled". This flag starts out not-yet-loaded, and the only
//      thing that loads it is a request. Treating not-yet-loaded as "off" meant that on any page other than
//      Settings or Insights - i.e. every page you actually play music from - listens were discarded at the
//      guard below while the database happily said the user had opted in. Events are now queued unless the
//      server has actually *said* the user is opted out; the server is the authority, it re-checks every
//      request anyway, and it answers a disabled batch with `historyEnabled: false`, which is what drains
//      the queue and settles this flag.
//
//   2. The hot path runs inside raw <audio> element event handlers, which are outside any Nuxt component
//      context. `useState` reaches for the Nuxt app instance there, so a plain module variable is both
//      cheaper and not liable to throw in the middle of playback.
type HistoryState = "unknown" | "enabled" | "disabled";

let historyState: HistoryState = "unknown";

/** reactive mirror for the UI. Never read on the capture path - see above. */
export const useHistoryEnabled = () => useState<boolean>("insights-history-enabled", () => false);

/** single writer for both the module flag and its reactive mirror */
export function setHistoryEnabledState(enabled: boolean): void {
    // module flag first: it is the one the capture path reads, and it must be updated even if the reactive
    // mirror below can't be. This runs from flush handlers that may sit outside any Nuxt component context,
    // where useState has no instance to attach to - a UI mirror that fails to update is cosmetic, capture
    // silently staying off is the bug this whole file exists to not have again.
    historyState = enabled ? "enabled" : "disabled";
    if (!import.meta.client) return;

    try {
        useHistoryEnabled().value = enabled;
    } catch {
        // no Nuxt context here; whichever screen reads the toggle re-syncs on mount anyway
    }
}

export function getHistoryState(): HistoryState {
    return historyState;
}

// Set by the highlight-reel player while it plays its 6-second excerpts. Without it, a twenty-slide reel
// would register as twenty sub-30-second plays and pollute the very data it is celebrating.
let suppressed = false;

export function setTrackingSuppressed(value: boolean): void {
    suppressed = value;
}

export function isTrackingSuppressed(): boolean {
    return suppressed;
}

// --- the queue ---------------------------------------------------------------------------------------

function readQueue(): QueuedPlayEvent[] {
    if (!import.meta.client) return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        // unreadable or corrupt: treat as empty rather than letting it break playback forever
        return [];
    }
}

function writeQueue(events: QueuedPlayEvent[]): void {
    if (!import.meta.client) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch {
        // storage full or blocked - the events are lost, which is a far better outcome than a thrown
        // exception interrupting the audio element
    }
}

function authToken(): string | null {
    const token = useCookie("nafynToken").value;
    return token || null;
}

/** queues one finished listen and opportunistically flushes. Safe to call from an audio event handler. */
export function enqueuePlayEvent(event: QueuedPlayEvent): void {
    if (!import.meta.client || suppressed) return;
    // only a confirmed opt-out stops capture. "unknown" still queues: the listen has already happened, and
    // throwing it away because a settings request hasn't come back yet loses real data for good.
    if (historyState === "disabled") return;
    if (event.duration_ms <= 0) return;

    const queue = readQueue();
    queue.push(event);

    // drop-oldest: a queue that has grown past the cap is almost certainly a client that has been offline or
    // unauthenticated for a very long time, and the recent listens are the ones worth keeping
    writeQueue(queue.slice(-MAX_QUEUED));

    void flushPlayEvents();
}

let flushing = false;

export async function flushPlayEvents(): Promise<void> {
    if (!import.meta.client || flushing) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    const token = authToken();
    if (!token) return;

    const queue = readQueue();
    if (queue.length === 0) return;

    const batch = queue.slice(0, MAX_PER_FLUSH);
    flushing = true;

    try {
        const result = await $fetch<{ accepted: number, rejected: number, historyEnabled: boolean }>(ENDPOINT, {
            method: "POST",
            headers: { Authorization: token },
            body: { events: batch }
        });

        // Remove by id, not by count. Events enqueued while the request was in flight sit at the end of the
        // stored queue by now, and splicing "the first N" would throw those away unsent.
        const sent = new Set(batch.map((e) => e.event_id));
        writeQueue(readQueue().filter((e) => !sent.has(e.event_id)));

        // the server is the authority on this, so its answer settles the flag in both directions: it
        // confirms an opt-in we only assumed, and it stops capture if the user turned history off elsewhere
        setHistoryEnabledState(result.historyEnabled);
        if (!result.historyEnabled) writeQueue([]);
    } catch {
        // left in the queue for the next attempt. A 4xx would strictly speaking be worth discarding, but
        // retrying a handful of rejected events is cheaper than reasoning about which failures are permanent.
    } finally {
        flushing = false;
    }
}

/**
 * Last-gasp flush as the page goes away.
 *
 * sendBeacon is the only thing browsers reliably run during pagehide, and it cannot set headers at all -
 * hence the `?token=` fallback the ingestion endpoint accepts, the same concession already made for
 * <audio> element sources and the downloads WebSocket.
 */
function beaconFlush(): void {
    if (!import.meta.client || typeof navigator === "undefined" || !navigator.sendBeacon) return;

    const token = authToken();
    if (!token) return;

    const queue = readQueue();
    if (queue.length === 0) return;

    const batch = queue.slice(0, MAX_PER_FLUSH);
    const url = `${ENDPOINT}?token=${encodeURIComponent(token)}`;
    const blob = new Blob([JSON.stringify({ events: batch })], { type: "application/json" });

    if (navigator.sendBeacon(url, blob)) {
        const sent = new Set(batch.map((e) => e.event_id));
        writeQueue(readQueue().filter((e) => !sent.has(e.event_id)));
    }
}

let listenersBound = false;

/** wires the background flush triggers. Idempotent; called once the first time the player is used. */
export function bindPlayTracking(): void {
    if (!import.meta.client || listenersBound) return;
    listenersBound = true;

    window.addEventListener("online", () => { void flushPlayEvents(); });
    window.addEventListener("pagehide", beaconFlush);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") beaconFlush();
    });

    const timer = setInterval(() => { void flushPlayEvents(); }, FLUSH_INTERVAL_MS);
    window.addEventListener("beforeunload", () => clearInterval(timer));
}

/**
 * Loads the user's opt-in state into shared state, and reports the browser's UTC offset so the server can
 * bucket days, weeks and years in the user's own calendar rather than the server's.
 */
export async function syncHistorySetting(): Promise<boolean> {
    if (!import.meta.client) return false;

    const token = authToken();
    if (!token) return false;

    try {
        const settings = await $fetch<{ historyEnabled: boolean, tzOffsetMinutes: number }>("/api/v1/insights/settings", {
            headers: { Authorization: token }
        });
        setHistoryEnabledState(settings.historyEnabled);

        // getTimezoneOffset() is minutes to add to *local* to get UTC, i.e. the opposite sign from what the
        // server stores
        const browserOffset = -new Date().getTimezoneOffset();
        if (settings.historyEnabled && settings.tzOffsetMinutes !== browserOffset) {
            await $fetch("/api/v1/insights/settings", {
                method: "PATCH",
                headers: { Authorization: token },
                body: { tzOffsetMinutes: browserOffset }
            }).catch(() => {});
        }

        return settings.historyEnabled;
    } catch {
        return false;
    }
}
