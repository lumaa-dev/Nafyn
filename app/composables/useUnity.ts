// Nafyn Unity: cross-device playback remote control. Drop-in replacement for usePlayer() - every consumer
// that only reads `state`/`currentTrack` and calls the usual mutators (play, togglePlay, seek, ...) works
// unchanged whether this device is acting as master (its own usePlayer() is the real audio engine) or as a
// slave (state is mirrored from the master over WebSocket, and every mutator sends a remote command instead
// of touching local playback).
//
// Authority model: the server (server/routes/ws/unity.ts, server/utils/unityRegistry.ts) is a relay and
// arbiter only, never the executor - it doesn't know what a "command" means, it just forwards it to whoever
// is currently master. Only the master's own browser can actually run usePlayer()'s mutators, because the
// real <audio> engine is module-level state local to that one tab.
import type { MediaRow } from "~~/server/core/library";
import { usePlayer, type PlayerState, type PlayContext, type QueuePosition } from "./usePlayer";
import { useUnitySettings, useUnitySessionOverride } from "./useUnitySettings";
import { useAuthToken } from "./useAuthToken";

export type UnityRole = "master" | "slave";
export type UnityMasterStatus = "active" | "grace" | "empty";

// reconnecting: 3 s, doubling per failed attempt up to a minute, with jitter so a server restart doesn't bring every
// open tab back in the same instant. Closes the server means as "don't": bad/revoked token (4001, 4003), Unity
// switched off (4002) or account deleted (4004) are retried only every few minutes - a fixed 3 s loop on those
// was every open tab hammering the handshake (and the token's session lookup) forever.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_REFUSED_MS = 5 * 60_000;
const REFUSED_CLOSE_CODES = new Set([4001, 4002, 4003, 4004]);
const STATE_BROADCAST_INTERVAL_MS = 1000;

let ws: WebSocket | null = null;
let initialized = false;
let pendingClaimResolve: ((granted: boolean) => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

function defaultMirrorState(): PlayerState {
    return { queue: [], currentIndex: -1, history: [], isPlaying: false, isLoading: false, currentTime: 0, duration: 0, volume: 1, muted: false, repeat: "off" };
}

export const useUnity = () => {
    const realPlayer = usePlayer();
    const unitySettings = useUnitySettings();
    const sessionOverride = useUnitySessionOverride();

    const role = useState<UnityRole>("unity-role", () => "slave");
    const masterStatus = useState<UnityMasterStatus>("unity-master-status", () => "empty");
    const masterDeviceLabel = useState<string | null>("unity-master-device", () => null);
    const mirrorState = useState<PlayerState>("unity-mirror-state", () => defaultMirrorState());
    const connected = useState<boolean>("unity-connected", () => false);

    // Unity is "live" only once the socket is actually up - while it's off, reconnecting, or the operator/user
    // disabled it, every mutator below falls back to plain local usePlayer() behavior, same as before Unity existed
    const shouldBeConnected = computed(() => unitySettings.value.enabled && !sessionOverride.value);
    const unityActive = computed(() => shouldBeConnected.value && connected.value);

    const isRemoteControlled = computed(() => unityActive.value && role.value === "slave" && masterStatus.value === "active");

    function send(message: Record<string, unknown>) {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }

    function sendState() {
        send({ type: "state", state: realPlayer.state.value });
    }

    function requestClaim(): Promise<boolean> {
        return new Promise((resolve) => {
            pendingClaimResolve = resolve;
            send({ type: "claim-master" });
        });
    }

    // wraps a usePlayer() mutator so it runs locally when this device is (or is about to become) master, and
    // is relayed to the real master otherwise. Every mutator shares this same logic - the server never needs
    // to know what "seek" or "playFromQueue" mean, it only ever forwards {action, payload} verbatim.
    function wrapMutator<A extends unknown[]>(name: string, localFn: (...args: A) => void) {
        return async (...args: A) => {
            if (!unityActive.value) {
                localFn(...args);
                return;
            }

            if (role.value === "master") {
                localFn(...args);
                sendState();
                return;
            }

            if (masterStatus.value === "empty") {
                const granted = await requestClaim();
                if (granted) {
                    role.value = "master";
                    localFn(...args);
                    sendState();
                    return;
                }
                // lost the race to another device claiming at the same instant - control them instead
            }

            send({ type: "command", action: name, payload: args });
        };
    }

    // not a wrapMutator: wiping the history must never claim master on a device that isn't playing anything
    function clearHistory() {
        realPlayer.clearHistory();
        if (isRemoteControlled.value) send({ type: "command", action: "clearHistory", payload: [] });
    }

    function takeover() {
        if (!unityActive.value) return;
        send({ type: "takeover" });
    }

    function applyIncomingCommand(action: string, payload: unknown[]) {
        const fn = (realPlayer as unknown as Record<string, (...a: unknown[]) => void>)[action];
        if (typeof fn !== "function") return;
        fn(...payload);
        // queue edits and the like don't wait for the next 1 s heartbeat to show up on the device that asked
        sendState();
    }

    // called when this device just became master (its own claim, or someone else's "take over" naming it, or
    // a takeover it performed itself): if the mirrored state still shows something playing, pick that session
    // up locally rather than just sitting on a blank player
    function resumeFromMirror() {
        realPlayer.restoreSession(mirrorState.value);
    }

    function handleMessage(raw: string) {
        let data: Record<string, unknown>;
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }

        switch (data.type) {
            case "snapshot": {
                role.value = data.role as UnityRole;
                masterStatus.value = data.masterStatus as UnityMasterStatus;
                masterDeviceLabel.value = data.masterDeviceLabel as string | null;
                if (data.state) mirrorState.value = data.state as PlayerState;
                return;
            }
            case "claim-granted":
                pendingClaimResolve?.(true);
                pendingClaimResolve = null;
                return;
            case "claim-rejected":
                pendingClaimResolve?.(false);
                pendingClaimResolve = null;
                return;
            case "master-changed": {
                const wasMaster = role.value === "master";
                const youAreMaster = data.youAreMaster as boolean;
                role.value = youAreMaster ? "master" : "slave";
                masterDeviceLabel.value = data.deviceLabel as string | null;
                masterStatus.value = "active";
                if (youAreMaster && !wasMaster) resumeFromMirror();
                else if (!youAreMaster && wasMaster && realPlayer.state.value.isPlaying) realPlayer.togglePlay();
                return;
            }
            case "state":
                mirrorState.value = data.state as PlayerState;
                return;
            case "command":
                applyIncomingCommand(data.action as string, data.payload as unknown[]);
                return;
            case "master-disconnected":
                masterStatus.value = "grace";
                return;
            case "master-cleared":
                masterStatus.value = "empty";
                masterDeviceLabel.value = null;
                mirrorState.value = defaultMirrorState();
                return;
            case "ping":
                send({ type: "pong" });
                return;
            case "error":
                console.warn(`[unity] ${data.code}: ${data.message}`);
                return;
        }
    }

    function connect() {
        if (!import.meta.client || ws || !shouldBeConnected.value) return;

        const token = useAuthToken().token.value ?? "";
        const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(`${wsProtocol}//${location.host}/ws/unity?token=${encodeURIComponent(token)}`);

        socket.addEventListener("open", () => { connected.value = true; reconnectAttempts = 0; });
        socket.addEventListener("message", (e) => handleMessage(e.data));
        socket.addEventListener("close", (e) => {
            connected.value = false;
            if (ws === socket) ws = null;
            scheduleReconnect(REFUSED_CLOSE_CODES.has(e.code));
        });
        socket.addEventListener("error", () => {});

        ws = socket;
    }

    function scheduleReconnect(refused: boolean) {
        if (reconnectTimer) return;
        const backoff = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts++, RECONNECT_MAX_MS);
        const delay = refused ? RECONNECT_REFUSED_MS : backoff * (0.75 + Math.random() * 0.5);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (shouldBeConnected.value) connect();
        }, delay);
    }

    function disconnect() {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        ws?.close();
        ws = null;
        connected.value = false;
        role.value = "slave";
        masterStatus.value = "empty";
        masterDeviceLabel.value = null;
    }

    if (import.meta.client && !initialized) {
        initialized = true;

        watch(shouldBeConnected, (should) => { if (should) connect(); else disconnect(); }, { immediate: true });

        setInterval(() => {
            if (role.value === "master" && connected.value) sendState();
        }, STATE_BROADCAST_INTERVAL_MS);
    }

    const state = computed<PlayerState>(() => isRemoteControlled.value ? mirrorState.value : realPlayer.state.value);
    const currentTrack = computed<MediaRow | null>(() => {
        const s = state.value;
        return s.currentIndex >= 0 ? s.queue[s.currentIndex] ?? null : null;
    });
    const hasNext = computed(() => {
        const s = state.value;
        return s.repeat === "queue" ? s.queue.length > 1 : s.currentIndex < s.queue.length - 1 || s.repeat === "track";
    });
    const hasPrev = computed(() => {
        const s = state.value;
        return s.repeat === "queue" ? s.queue.length > 1 : s.currentIndex > 0;
    });

    return {
        state,
        currentTrack,
        hasNext,
        hasPrev,
        role,
        masterStatus,
        masterDeviceLabel,
        takeover,
        play: wrapMutator("play", (track: MediaRow, queue?: MediaRow[], context?: PlayContext) => realPlayer.play(track, queue, context)),
        togglePlay: wrapMutator("togglePlay", () => realPlayer.togglePlay()),
        stop: wrapMutator("stop", () => realPlayer.stop()),
        next: wrapMutator("next", () => realPlayer.next()),
        prev: wrapMutator("prev", () => realPlayer.prev()),
        seek: wrapMutator("seek", (time: number) => realPlayer.seek(time)),
        setVolume: wrapMutator("setVolume", (volume: number) => realPlayer.setVolume(volume)),
        toggleMute: wrapMutator("toggleMute", () => realPlayer.toggleMute()),
        addToQueue: wrapMutator("addToQueue", (track: MediaRow, position?: QueuePosition) => realPlayer.addToQueue(track, position)),
        removeFromQueue: wrapMutator("removeFromQueue", (index: number, trackId: string) => realPlayer.removeFromQueue(index, trackId)),
        moveInQueue: wrapMutator("moveInQueue", (from: number, to: number, trackId: string) => realPlayer.moveInQueue(from, to, trackId)),
        playFromQueue: wrapMutator("playFromQueue", (index: number) => realPlayer.playFromQueue(index)),
        playFromHistory: wrapMutator("playFromHistory", (index: number, trackId: string) => realPlayer.playFromHistory(index, trackId)),
        clearHistory,
        cycleRepeat: wrapMutator("cycleRepeat", () => realPlayer.cycleRepeat()),
        setRepeat: wrapMutator("setRepeat", (mode: PlayerState["repeat"]) => realPlayer.setRepeat(mode))
    };
};
