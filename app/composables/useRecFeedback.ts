// what the person did with a Discover card, reported back to the bandit (POST /api/v1/recommendations/feedback).
//
// Opening a card starts an "attribution": for the next 30 minutes (the server's window), what is played,
// previewed or requested from what the card leads to counts for that card's (decision, slot):
//   - a mix:        its tracks (filled in by the mix page once it has loaded them) and its suggestions
//   - a suggestion: that recording's preview and request
//   - an album / playlist: playback started within 10 minutes of opening it
// The player reports every finished listen (usePlayer's endSegment), usePreview every finished preview and
// useMediaRequest every request; each is matched against the open attributions here.
//
// Module-level and client-only: these calls come from <audio> event handlers outside any component.
import { useAuthToken } from "~/composables/useAuthToken";

interface Attribution {
    decisionId: string,
    slot: number,
    /** "mix:<id>", "suggestion:<mbid>", "album:<id>", "playlist:<id>" */
    ref: string,
    openedAt: number,
    /** media ids whose listens count; null = anything started within OPEN_PLAY_MS of opening */
    trackIds: Set<string> | null,
    recordingIds: Set<string>
}

const WINDOW_MS = 30 * 60_000;
const OPEN_PLAY_MS = 10 * 60_000;
const MAX_ATTRIBUTIONS = 8;
let attributions: Attribution[] = [];

function live(): Attribution[] {
    const now = Date.now();
    attributions = attributions.filter((a) => now - a.openedAt < WINDOW_MS);
    return attributions;
}

function send(a: Attribution, event: "open" | "play" | "preview" | "request", msPlayed = 0) {
    if (!import.meta.client) return;
    const token = useAuthToken().token.value;
    if (!token) return;
    // background traffic the person did not ask for: never a toast (DESIGN.md "Error messages")
    $fetch("/api/v1/recommendations/feedback", {
        method: "POST",
        headers: { Authorization: token },
        body: { decisionId: a.decisionId, slot: a.slot, event, msPlayed: Math.round(msPlayed) }
    }).catch(() => {});
}

/** a card was opened (or its play button pressed) */
export function noteCardOpened(decisionId: string, slot: number, kind: string, refId: string): void {
    const ref = `${kind}:${refId}`;
    const existing = live().find((a) => a.decisionId === decisionId && a.slot === slot);
    const a: Attribution = existing ?? {
        decisionId,
        slot,
        ref,
        openedAt: Date.now(),
        trackIds: kind === "mix" ? new Set() : kind === "suggestion" ? new Set() : null,
        recordingIds: new Set(kind === "suggestion" ? [refId.toLowerCase()] : [])
    };
    if (!existing) {
        attributions = [a, ...live()].slice(0, MAX_ATTRIBUTIONS);
    }
    send(a, "open");
}

/** the mix page, once loaded: which tracks and suggestions belong to the mix card that led there */
export function attributeMix(mixId: string, mediaIds: readonly string[], recordingIds: readonly string[]): void {
    for (const a of live()) {
        if (a.ref !== `mix:${mixId}`) continue;
        a.trackIds = new Set(mediaIds);
        a.recordingIds = new Set(recordingIds.map((r) => r.toLowerCase()));
    }
}

/** usePlayer: a listen of `trackId` that started at `startedAt` lasted `ms` */
export function reportRecListen(trackId: string, startedAt: number, ms: number): void {
    for (const a of live()) {
        const matches = a.trackIds ? a.trackIds.has(trackId) : startedAt >= a.openedAt && startedAt - a.openedAt < OPEN_PLAY_MS;
        if (matches) send(a, "play", ms);
    }
}

/** usePreview: a preview of recording `recordingId` was listened to for `ms` */
export function reportRecPreview(recordingId: string, ms: number): void {
    for (const a of live()) if (a.recordingIds.has(recordingId.toLowerCase())) send(a, "preview", ms);
}

/** useMediaRequest: recording `recordingId` was requested */
export function reportRecRequest(recordingId: string): void {
    for (const a of live()) if (a.recordingIds.has(recordingId.toLowerCase())) send(a, "request");
}
