// global "Now Playing" audio engine: one <audio> element shared across every page via useState
import type { MediaRow } from "~~/server/core/library";
import type { RecentlyPlayedType } from "~~/server/core/recentlyPlayed";
import { enqueuePlayEvent, bindPlayTracking, type PlaySource } from "./usePlayTracking";

export type RepeatMode = "off" | "queue" | "track";

export interface PlayContext {
    type: RecentlyPlayedType;
    refId: string;
}

// fire-and-forget: recording a recently-played entry should never block/break playback
function recordRecentlyPlayed(context: PlayContext) {
    if (!import.meta.client) return;
    const token = useCookie("nafynToken").value;
    if (!token) return;

    $fetch("/api/v1/library/recently-played", {
        method: "POST",
        headers: { Authorization: token },
        body: { type: context.type, refId: context.refId }
    }).catch(() => {});
}

// --- listening-history capture ----------------------------------------------------------------------
//
// A "segment" is one continuous listen of one track: from the moment it starts playing until it is replaced,
// skipped, stopped or reaches its end. It exists because the player had no time accounting at all - the
// audio element reports a position, not how long a human actually spent listening to it.
//
// Elapsed time is measured in WALL CLOCK (Date.now() deltas across playing intervals), never as a difference
// in `currentTime`. That is the whole reason seeking needs no special handling: dragging the scrubber to the
// last second of a track moves currentTime by three minutes but costs the listener nothing, and only a
// wall-clock measure refuses to credit it.
interface Segment {
    track: MediaRow;
    playlistId: string | null;
    source: PlaySource;
    startedAtMs: number;
    accumulatedMs: number;
    /** Date.now() when the current playing interval began; null while paused */
    lastResumeMs: number | null;
    /** furthest position reached, in seconds - decides skip vs. complete */
    maxPositionSec: number;
}

let segment: Segment | null = null;

// where the current queue came from, so tracks reached by queue advance or repeat are attributed to the same
// album/playlist the user actually pressed play on
let currentContext: PlayContext | null = null;

// mirrors insightsConfig.nearCompleteRatio on the server. A play that got this far counts as finished even
// if the element never fired "ended" - which is what happens when someone hits Next during an outro.
const NEAR_COMPLETE_RATIO = 0.85;

function contextToSource(context: PlayContext | null): PlaySource {
    // PlayContext.type already maps 1:1 onto the server's `source` enum; no context means the track was
    // played straight from the library
    return context ? (context.type as PlaySource) : "library";
}

function startSegment(track: MediaRow) {
    if (!import.meta.client) return;
    segment = {
        track,
        playlistId: currentContext?.type === "playlist" ? currentContext.refId : null,
        source: contextToSource(currentContext),
        startedAtMs: Date.now(),
        accumulatedMs: 0,
        lastResumeMs: null,
        maxPositionSec: 0
    };
}

// folds the interval in progress into the running total; called on pause and again when the segment ends
function accumulateSegment() {
    if (!segment || segment.lastResumeMs === null) return;
    segment.accumulatedMs += Date.now() - segment.lastResumeMs;
    segment.lastResumeMs = null;
}

type SegmentEnd = "ended" | "skipped" | "replaced" | "stopped";

function endSegment(reason: SegmentEnd) {
    if (!segment) return;

    accumulateSegment();
    const finished = segment;
    segment = null;

    if (finished.accumulatedMs <= 0) return;

    const trackDurationSec = finished.track.duration;
    const completed = reason === "ended"
        || (trackDurationSec > 0 && finished.maxPositionSec >= trackDurationSec * NEAR_COMPLETE_RATIO);

    enqueuePlayEvent({
        event_id: crypto.randomUUID(),
        track_id: finished.track.id,
        playlist_id: finished.playlistId,
        started_at: finished.startedAtMs,
        duration_ms: Math.round(finished.accumulatedMs),
        completed,
        source: finished.source
    });
}

export interface PlayerState {
    queue: MediaRow[];
    currentIndex: number;
    isPlaying: boolean;
    isLoading: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    muted: boolean;
    repeat: RepeatMode;
}

let audioEl: HTMLAudioElement | null = null;

function getAudioEl(state: PlayerState): HTMLAudioElement {
    if (audioEl) return audioEl;

    audioEl = new Audio();
    audioEl.preload = "metadata";
    audioEl.volume = state.volume;

    audioEl.addEventListener("timeupdate", () => {
        state.currentTime = audioEl!.currentTime;
        if (segment && audioEl!.currentTime > segment.maxPositionSec) segment.maxPositionSec = audioEl!.currentTime;
        updatePositionState(audioEl!);
    });
    audioEl.addEventListener("durationchange", () => { state.duration = Number.isFinite(audioEl!.duration) ? audioEl!.duration : 0; updatePositionState(audioEl!); });
    audioEl.addEventListener("play", () => {
        state.isPlaying = true;
        if (segment && segment.lastResumeMs === null) segment.lastResumeMs = Date.now();
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    });
    audioEl.addEventListener("pause", () => {
        state.isPlaying = false;
        // paused time is not listening time
        accumulateSegment();
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    });
    audioEl.addEventListener("waiting", () => { state.isLoading = true; });
    audioEl.addEventListener("canplay", () => { state.isLoading = false; });
    audioEl.addEventListener("ended", () => {
        const finishedTrack = segment?.track ?? null;
        endSegment("ended");

        if (state.repeat === "track") {
            audioEl!.currentTime = 0;
            audioEl!.play().catch(() => { state.isPlaying = false; });
            // repeat-track replays without going through loadCurrent(), so nothing else would open a new
            // segment - this line is what makes looping a track count every single time round, with no caps
            // and no dampening. That is deliberate and specified; please don't "fix" it.
            if (finishedTrack) startSegment(finishedTrack);
            return;
        }
        goToOffset(state, 1);
    });

    return audioEl;
}

function trackStreamUrl(track: MediaRow): string {
    const token = useCookie("nafynToken").value ?? "";
    return `/api/v1/library/${track.id}/stream?token=${encodeURIComponent(token)}`;
}

// populates the OS/browser "now playing" surface (iOS/macOS Control Center, Windows media overlay, Chrome media hub, etc.)
function updateMediaSessionMetadata(track: MediaRow) {
    if (!import.meta.client || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artistName,
        album: track.album ?? "",
        artwork: track.coverArt ? [{ src: track.coverArt.replace("front-250", "front-1000"), sizes: "1000x1000", type: "image/jpeg" }] : [{ src: `../assets/no-cover.png`, sizes: "1000x1000", type: "image/png" }]
    });
}

// tells the OS where in the track we are, so its scrubber/lock-screen progress bar stays in sync
function updatePositionState(el: HTMLAudioElement) {
    if (!import.meta.client || !("mediaSession" in navigator)) return;
    if (!Number.isFinite(el.duration) || el.duration <= 0) return;
    try {
        navigator.mediaSession.setPositionState({
            duration: el.duration,
            playbackRate: el.playbackRate,
            position: Math.min(el.currentTime, el.duration)
        });
    } catch {
        // position can be briefly out of range while a new track's src is still swapping in
    }
}

// loads whatever `state.currentIndex` now points to; the browser fetches only the first chunk of audio, then ranges in the rest as playback/seeking demands it
function loadCurrent(state: PlayerState, autoplay: boolean) {
    if (!import.meta.client) return;
    const track = state.queue[state.currentIndex];
    if (!track) return;

    // the single chokepoint for "the current track is no longer the current track" - play(), skipToIndex()
    // and goToOffset() all arrive here, so closing the outgoing segment once covers all three
    endSegment("replaced");

    const el = getAudioEl(state);
    startSegment(track);
    state.currentTime = 0;
    state.duration = 0;
    state.isLoading = true;
    el.src = trackStreamUrl(track);
    el.volume = state.volume / 5
    el.load();
    updateMediaSessionMetadata(track);
    if (autoplay) el.play().catch(() => { state.isPlaying = false; });
}

function skipToIndex(state: PlayerState, index: number) {
    if (index < 0 || index >= state.queue.length) {
        stop(state);
        return;
    }
    state.currentIndex = index;
    loadCurrent(state, true);
}

// moves `offset` (+1/-1) tracks from the current one; with repeat-queue this wraps around instead of stopping at the ends. Returns false when there was nothing to do (caller decides the fallback, e.g. seeking to 0).
function goToOffset(state: PlayerState, offset: 1 | -1): boolean {
    const lastIndex = state.queue.length - 1;
    if (lastIndex < 0) return false;

    let target = state.currentIndex + offset;

    if (target < 0) {
        if (state.repeat !== "queue") return false;
        target = lastIndex;
    } else if (target > lastIndex) {
        if (state.repeat !== "queue") {
            stop(state);
            return true;
        }
        target = 0;
    }

    state.currentIndex = target;
    loadCurrent(state, true);
    return true;
}

function stop(state: PlayerState) {
    endSegment("stopped");
    if (import.meta.client && audioEl) {
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
    }
    if (import.meta.client && "mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
    }
    state.queue = [];
    state.currentIndex = -1;
    state.isPlaying = false;
    state.currentTime = 0;
    state.duration = 0;
}

let mediaSessionActionsBound = false;

// wires OS/lock-screen/hardware media keys (play, pause, previous, next, scrub) to the player; only needs to run once since every usePlayer() call shares the same underlying state
function bindMediaSessionActions(actions: { togglePlay: () => void; next: () => void; prev: () => void; seek: (time: number) => void }) {
    if (!import.meta.client || mediaSessionActionsBound || !("mediaSession" in navigator)) return;
    mediaSessionActionsBound = true;

    navigator.mediaSession.setActionHandler("play", () => actions.togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => actions.togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => actions.prev());
    navigator.mediaSession.setActionHandler("nexttrack", () => actions.next());
    navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (typeof details.seekTime === "number") actions.seek(details.seekTime);
    });
}

export const usePlayer = () => {
    const state = useState<PlayerState>("player", () => ({
        queue: [],
        currentIndex: -1,
        isPlaying: false,
        isLoading: false,
        currentTime: 0,
        duration: 0,
        volume: 1,
        muted: false,
        repeat: "off"
    }));

    const currentTrack = computed(() => state.value.currentIndex >= 0 ? state.value.queue[state.value.currentIndex] ?? null : null);

    const hasNext = computed(() => state.value.repeat === "queue" ? state.value.queue.length > 1 : state.value.currentIndex < state.value.queue.length - 1 || state.value.repeat == "track");
    const hasPrev = computed(() => state.value.repeat === "queue" ? state.value.queue.length > 1 : state.value.currentIndex > 0);

    // plays `track` immediately; if `queue` is given it replaces the whole queue (e.g. "play this track from this list"), otherwise the track is appended and jumped to.
    // `context` records where playback was started from (a track list, an album, a playlist) into "recently played" -
    // omit it for internal/derived plays (queue navigation, repeat, etc.) that don't represent a fresh "play this" action
    function play(track: MediaRow, queue?: MediaRow[], context?: PlayContext) {
        if (queue) {
            state.value.queue = queue;
            state.value.currentIndex = queue.findIndex(t => t.id === track.id);
        } else {
            const existing = state.value.queue.findIndex(t => t.id === track.id);
            if (existing >= 0) {
                state.value.currentIndex = existing;
            } else {
                state.value.queue.push(track);
                state.value.currentIndex = state.value.queue.length - 1;
            }
        }
        // remembered for the whole queue, so a track reached by pressing Next is still attributed to the
        // album or playlist the user started from
        currentContext = context ?? null;

        loadCurrent(state.value, true);
        if (context) recordRecentlyPlayed(context);
    }

    function togglePlay() {
        if (!import.meta.client || !currentTrack.value) return;
        const el = getAudioEl(state.value);
        if (el.paused) el.play().catch(() => {});
        else el.pause();
    }

    function next() {
        if (state.value.repeat == "track") {
            // restarting the same track on purpose is a new listen, not a continuation of the old one
            const track = currentTrack.value;
            endSegment("skipped");
            if (track) startSegment(track);
            seek(0);
        } else {
            goToOffset(state.value, 1);
        }
    }

    // scrubs back to 0 if we're more than 3s into the track (standard "previous button" behavior), otherwise goes to the previous track
    function prev() {
        if (!import.meta.client) return;
        const el = getAudioEl(state.value);
        if (el.currentTime > 3) {
            // same as next()-under-repeat: the user is deliberately hearing it again
            const track = currentTrack.value;
            endSegment("skipped");
            if (track) startSegment(track);
            el.currentTime = 0;
            return;
        }
        if (!goToOffset(state.value, -1)) {
            el.currentTime = 0;
        }
    }

    // off -> queue (loop the whole queue) -> track (loop the current song) -> off
    function cycleRepeat() {
        state.value.repeat = state.value.repeat === "off" ? "queue" : state.value.repeat === "queue" ? "track" : "off";
    }

    function setRepeat(mode: RepeatMode) {
        state.value.repeat = mode;
    }

    function seek(time: number) {
        if (!import.meta.client) return;
        getAudioEl(state.value).currentTime = time;
    }

    function setVolume(volume: number) {
        const newVol = Math.min(1.0, Math.max(volume, 0.0));
        state.value.volume = newVol;
        state.value.muted = newVol === 0;
        if (import.meta.client) getAudioEl(state.value).volume = newVol / 5;
    }

    function toggleMute() {
        state.value.muted = !state.value.muted;
        if (import.meta.client) getAudioEl(state.value).muted = state.value.muted;
    }

    function addToQueue(track: MediaRow) {
        state.value.queue.push(track);
        if (state.value.currentIndex === -1) skipToIndex(state.value, 0);
    }

    function removeFromQueue(index: number) {
        if (index === state.value.currentIndex) {
            stop(state.value);
            return;
        }
        state.value.queue.splice(index, 1);
        if (index < state.value.currentIndex) state.value.currentIndex--;
    }

    function playFromQueue(index: number) {
        skipToIndex(state.value, index);
    }

    bindMediaSessionActions({ togglePlay, next, prev, seek });
    bindPlayTracking();

    return {
        state,
        currentTrack,
        hasNext,
        hasPrev,
        play,
        togglePlay,
        stop: () => stop(state.value),
        next,
        prev,
        seek,
        setVolume,
        toggleMute,
        addToQueue,
        removeFromQueue,
        playFromQueue,
        cycleRepeat,
        setRepeat
    };
}
