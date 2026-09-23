// global "Now Playing" audio engine: one <audio> element shared across every page via useState
import type { MediaRow } from "~~/server/core/library";
import type { RecentlyPlayedType } from "~~/server/core/recentlyPlayed";
import type { Ref } from "vue";
import { enqueuePlayEvent, bindPlayTracking, type PlaySource } from "./usePlayTracking";
import { usePlaybackSettings, type PlaybackSettings } from "./usePlaybackSettings";

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

// --- audio engine: two decks ----------------------------------------------------------------------------
//
// Two <audio> elements ("decks") take turns being the active one. The idle deck preloads whatever plays
// next during the last PRELOAD_LEAD_SEC of the current track, so both automatic transitions and a Next press
// near the end start from an already-buffered element. A crossfade plays both decks at once: the incoming
// deck becomes active (it owns `state` from the first instant) while the outgoing one fades out and is
// retired on its own "ended". Every element event listener checks it comes from the active deck - the
// outgoing/idle deck must never write to `state`.
//
// Fades run on Web Audio GainNodes, not `el.volume`: gain automation is scheduled on the audio thread, so it
// stays sample-accurate and smooth even in a hidden tab where timers and rAF are throttled. Without Web
// Audio (context creation failed) crossfading is simply disabled and transitions stay hard cuts.

interface Deck {
    el: HTMLAudioElement;
    gain: GainNode | null;
    /** track the element holds; for the idle deck, non-null means "preloaded, paused at 0, ready to go" */
    trackId: string | null;
}

interface Crossfade {
    outgoing: Deck;
    incoming: Deck;
    /** AudioContext time the gain ramps finish; Infinity until the incoming deck actually starts playing */
    endsAt: number;
}

const PRELOAD_LEAD_SEC = 30;
const MIN_CROSSFADE_SEC = 0.5;
const HAVE_FUTURE_DATA = 3;

let decks: [Deck, Deck] | null = null;
let activeDeckIndex = 0;
let crossfade: Crossfade | null = null;

// Web Audio analyser fed by both decks, used by NowPlaying's background gradient to pulse with the actual
// bass energy of whatever is playing rather than a guessed BPM. createMediaElementSource can only ever be
// called once per element, so the whole graph is built once, together with the decks.
let audioCtx: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let analyserData: Uint8Array<ArrayBuffer> | null = null;

// captured from usePlayer()'s setup context, since element event listeners run outside any Nuxt context
let playbackSettings: Ref<PlaybackSettings> | null = null;

// 0..1 average energy of the low-frequency bins ("bass") for the current playback instant - a cheap,
// dependency-free stand-in for real beat detection that still moves in time with the actual audio
export function getBassLevel(): number {
    if (!analyserNode || !analyserData) return 0;
    analyserNode.getByteFrequencyData(analyserData);
    const bassBins = 8;
    let sum = 0;
    for (let i = 0; i < bassBins; i++) sum += analyserData[i] ?? 0;
    return sum / bassBins / 255;
}

function buildGraph(els: HTMLAudioElement[]): (GainNode | null)[] {
    try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        // the analyser only taps the signal on its way to the destination - without this connection the
        // elements go silent
        analyser.connect(ctx.destination);

        const gains = els.map((el) => {
            const gain = ctx.createGain();
            ctx.createMediaElementSource(el).connect(gain);
            gain.connect(analyser);
            return gain;
        });

        audioCtx = ctx;
        analyserNode = analyser;
        analyserData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        return gains;
    } catch {
        return els.map(() => null);
    }
}

function getDecks(state: PlayerState): [Deck, Deck] {
    if (decks) return decks;

    const els = [new Audio(), new Audio()];
    for (const el of els) {
        el.preload = "auto";
        el.volume = state.volume / 5;
        el.muted = state.muted;
    }
    const gains = buildGraph(els);
    decks = [
        { el: els[0]!, gain: gains[0] ?? null, trackId: null },
        { el: els[1]!, gain: gains[1] ?? null, trackId: null }
    ];
    for (const deck of decks) bindDeckEvents(deck, state);
    return decks;
}

function activeDeck(state: PlayerState): Deck {
    return getDecks(state)[activeDeckIndex] as Deck;
}

function idleDeck(state: PlayerState): Deck {
    return getDecks(state)[1 - activeDeckIndex] as Deck;
}

function isActive(deck: Deck): boolean {
    return decks !== null && decks[activeDeckIndex] === deck;
}

function getAudioEl(state: PlayerState): HTMLAudioElement {
    return activeDeck(state).el;
}

function bindDeckEvents(deck: Deck, state: PlayerState) {
    const el = deck.el;

    el.addEventListener("timeupdate", () => {
        if (!isActive(deck)) return;
        state.currentTime = el.currentTime;
        if (segment && el.currentTime > segment.maxPositionSec) segment.maxPositionSec = el.currentTime;
        updatePositionState(el);
        onActiveTimeUpdate(state, deck);
    });
    el.addEventListener("durationchange", () => {
        if (!isActive(deck)) return;
        state.duration = Number.isFinite(el.duration) ? el.duration : 0;
        updatePositionState(el);
    });
    el.addEventListener("play", () => {
        if (!isActive(deck)) return;
        state.isPlaying = true;
        if (segment && segment.lastResumeMs === null) segment.lastResumeMs = Date.now();
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
        if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => {});
    });
    el.addEventListener("pause", () => {
        if (!isActive(deck)) return;
        state.isPlaying = false;
        // paused time is not listening time
        accumulateSegment();
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    });
    el.addEventListener("waiting", () => { if (isActive(deck)) state.isLoading = true; });
    el.addEventListener("canplay", () => { if (isActive(deck)) state.isLoading = false; });
    el.addEventListener("ended", () => {
        if (crossfade?.outgoing === deck) {
            finishCrossfade();
            return;
        }
        if (!isActive(deck)) return;

        const finishedTrack = segment?.track ?? null;
        endSegment("ended");

        if (state.repeat === "track") {
            el.currentTime = 0;
            el.play().catch(() => { state.isPlaying = false; });
            // repeat-track replays without going through loadCurrent(), so nothing else would open a new
            // segment - this line is what makes looping a track count every single time round, with no caps
            // and no dampening. That is deliberate and specified; please don't "fix" it.
            if (finishedTrack) startSegment(finishedTrack);
            return;
        }
        goToOffset(state, 1);
    });
}

// the track an *automatic* advance would go to, or null when there is none (end of queue, repeat-one, or a
// one-track repeat-queue, which just restarts in place)
function autoNextIndex(state: PlayerState): number | null {
    if (state.repeat === "track") return null;
    const lastIndex = state.queue.length - 1;
    if (state.currentIndex < lastIndex) return state.currentIndex + 1;
    if (state.repeat === "queue" && lastIndex > 0) return 0;
    return null;
}

// consecutive tracks of the same album flow into each other as the artist sequenced them (live albums,
// DJ mixes, segued concept records) - fading them would ruin exactly the transitions that were meant to
// be heard. Anything else, including an album track followed by a later/earlier one of the same album, fades.
function isAlbumContinuation(from: MediaRow, to: MediaRow): boolean {
    return !!from.albumId
        && from.albumId === to.albumId
        && from.trackNumber !== null
        && to.trackNumber !== null
        && to.trackNumber === from.trackNumber + 1;
}

// seconds to crossfade from `current` into `next`, or 0 for a plain transition. Never more than half of
// either track, so a short interlude is never mostly buried under its neighbours.
function crossfadeSeconds(current: HTMLAudioElement, currentTrack: MediaRow, next: MediaRow): number {
    const settings = playbackSettings?.value;
    if (!settings?.crossfadeEnabled || !audioCtx) return 0;
    if (isAlbumContinuation(currentTrack, next)) return 0;

    let seconds = settings.crossfadeMs / 1000;
    seconds = Math.min(seconds, current.duration / 2);
    if (next.duration > 0) seconds = Math.min(seconds, next.duration / 2);
    return seconds >= MIN_CROSSFADE_SEC ? seconds : 0;
}

function loadIntoDeck(deck: Deck, track: MediaRow) {
    deck.el.src = trackStreamUrl(track);
    deck.el.load();
    deck.trackId = track.id;
}

function setGain(deck: Deck, value: number) {
    if (!deck.gain || !audioCtx) return;
    const param = deck.gain.gain;
    try {
        param.cancelScheduledValues(0);
        param.setValueAtTime(value, audioCtx.currentTime);
    } catch {
        param.value = value;
    }
}

// equal-power curve: the summed loudness stays constant across the fade, where a linear one dips audibly
// in the middle
function equalPowerCurve(fadeIn: boolean): Float32Array<ArrayBuffer> {
    const steps = 128;
    const curve = new Float32Array(new ArrayBuffer(steps * 4));
    for (let i = 0; i < steps; i++) {
        const x = (i / (steps - 1)) * (Math.PI / 2);
        curve[i] = fadeIn ? Math.sin(x) : Math.cos(x);
    }
    return curve;
}

function onActiveTimeUpdate(state: PlayerState, deck: Deck) {
    if (crossfade) {
        // safety net in case the outgoing element never reports "ended" (e.g. wrong duration metadata)
        if (audioCtx && audioCtx.currentTime > crossfade.endsAt + 0.5) finishCrossfade();
        return;
    }

    const el = deck.el;
    if (el.paused || !Number.isFinite(el.duration) || el.duration <= 0) return;

    const nextIndex = autoNextIndex(state);
    if (nextIndex === null) return;
    const current = state.queue[state.currentIndex];
    const next = state.queue[nextIndex];
    if (!current || !next) return;

    const remaining = el.duration - el.currentTime;
    const idle = idleDeck(state);

    // re-checked on every tick rather than once, so a queue edit that changes what's next is picked up
    if (remaining <= PRELOAD_LEAD_SEC && idle.trackId !== next.id) {
        idle.el.pause();
        loadIntoDeck(idle, next);
    }

    const fade = crossfadeSeconds(el, current, next);
    if (fade > 0 && remaining <= fade) startCrossfade(state, nextIndex);
}

function startCrossfade(state: PlayerState, nextIndex: number) {
    const next = state.queue[nextIndex];
    if (!next) return;

    const outgoing = activeDeck(state);
    const incoming = idleDeck(state);
    if (incoming.trackId !== next.id || incoming.el.error) loadIntoDeck(incoming, next);
    else if (incoming.el.currentTime !== 0) incoming.el.currentTime = 0;

    const fade: Crossfade = { outgoing, incoming, endsAt: Number.POSITIVE_INFINITY };
    crossfade = fade;

    // the outgoing track played to its natural end as far as the listener is concerned
    endSegment("ended");
    state.currentIndex = nextIndex;
    setGain(incoming, 0);
    activateDeck(state, incoming, next);

    const token = ++loadToken;
    incoming.el.play()
        .then(() => {
            // ramps start when the incoming deck is really producing sound, so a slow buffer can shorten
            // the overlap but never open a silent gap between the two tracks
            if (crossfade !== fade || !audioCtx) return;
            const remaining = outgoing.el.duration - outgoing.el.currentTime;
            const duration = Math.max(0.05, Number.isFinite(remaining) ? remaining : 0.05);
            const now = audioCtx.currentTime;
            try {
                outgoing.gain!.gain.cancelScheduledValues(0);
                outgoing.gain!.gain.setValueCurveAtTime(equalPowerCurve(false), now, duration);
                incoming.gain!.gain.cancelScheduledValues(0);
                incoming.gain!.gain.setValueCurveAtTime(equalPowerCurve(true), now, duration);
                fade.endsAt = now + duration;
            } catch {
                finishCrossfade();
            }
        })
        .catch(() => {
            if (token !== loadToken) return;
            state.isPlaying = false;
            finishCrossfade();
        });
}

// retires the outgoing deck and leaves the incoming one at full volume; also the abort path for any manual
// action (pause, seek, skip) that lands mid-fade
function finishCrossfade() {
    if (!crossfade) return;
    const { outgoing, incoming } = crossfade;
    crossfade = null;
    outgoing.el.pause();
    outgoing.trackId = null;
    setGain(incoming, 1);
}

// makes `deck` the active one and mirrors its element into `state`, which none of its events touched while idle
function activateDeck(state: PlayerState, deck: Deck, track: MediaRow) {
    activeDeckIndex = getDecks(state).indexOf(deck);
    startSegment(track);
    state.currentTime = deck.el.currentTime;
    state.duration = Number.isFinite(deck.el.duration) ? deck.el.duration : 0;
    state.isLoading = deck.el.readyState < HAVE_FUTURE_DATA;
    updateMediaSessionMetadata(track);
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
        artwork: (track.coverArt || track.hasCustomCover) ? [{ src: coverSrc(track).replace("front-250", "front-1000"), sizes: "1000x1000", type: "image/jpeg" }] : [{ src: `../assets/no-cover.png`, sizes: "1000x1000", type: "image/png" }]
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

// bumped on every load/crossfade so a play() promise from a since-superseded one can tell it's stale and
// not stomp state.isPlaying for whatever track is actually loaded now
let loadToken = 0;

// loads whatever `state.currentIndex` now points to - a manual jump (play, skip, queue click) or an automatic
// advance with no crossfade. Uses the idle deck when it already has that track preloaded.
function loadCurrent(state: PlayerState, autoplay: boolean) {
    if (!import.meta.client) return;
    const track = state.queue[state.currentIndex];
    if (!track) return;

    // the single chokepoint for "the current track is no longer the current track" - play(), skipToIndex()
    // and goToOffset() all arrive here, so closing the outgoing segment once covers all three
    endSegment("replaced");
    finishCrossfade();

    let deck = activeDeck(state);
    const idle = idleDeck(state);
    if (idle.trackId === track.id && !idle.el.error) {
        deck.el.pause();
        deck.trackId = null;
        deck = idle;
        if (deck.el.currentTime !== 0) deck.el.currentTime = 0;
    } else {
        loadIntoDeck(deck, track);
    }
    setGain(deck, 1);
    activateDeck(state, deck, track);
    state.currentTime = 0;

    const token = ++loadToken;
    // rejects e.g. with AbortError when a later load interrupts this same play() call - if that happened,
    // the newer call already owns state.isPlaying and this stale rejection must not touch it
    if (autoplay) deck.el.play().catch(() => { if (token === loadToken) state.isPlaying = false; });
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
    finishCrossfade();
    if (import.meta.client && decks) {
        for (const deck of decks) {
            deck.el.pause();
            deck.el.removeAttribute("src");
            deck.el.load();
            deck.trackId = null;
        }
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
    // client only: a module-level ref would otherwise leak one request's state into the next during SSR
    if (import.meta.client) playbackSettings ??= usePlaybackSettings();

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
        else {
            finishCrossfade();
            el.pause();
        }
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
            finishCrossfade();
            el.currentTime = 0;
            return;
        }
        if (!goToOffset(state.value, -1)) {
            finishCrossfade();
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
        finishCrossfade();
        getAudioEl(state.value).currentTime = time;
    }

    function setVolume(volume: number) {
        const newVol = Math.min(1.0, Math.max(volume, 0.0));
        state.value.volume = newVol;
        state.value.muted = newVol === 0;
        if (import.meta.client) {
            for (const deck of getDecks(state.value)) deck.el.volume = newVol / 5;
        }
    }

    function toggleMute() {
        state.value.muted = !state.value.muted;
        if (import.meta.client) {
            for (const deck of getDecks(state.value)) deck.el.muted = state.value.muted;
        }
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
