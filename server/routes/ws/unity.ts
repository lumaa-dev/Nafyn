// Nafyn Unity: cross-device playback remote control. Connect with `?token=<jwt>`
// (browsers can't set custom headers on a WebSocket handshake, so the token travels as a query param instead
// of `Authorization`, same as ws/downloads.ts).
import { verifyAuthToken } from "../../utils/jwt";
import { labelUserAgent } from "../../utils/userAgent";
import {
    getSnapshot,
    registerConnection,
    claimMaster,
    takeoverMaster,
    applyState,
    forwardCommand,
    handleClose,
    connectionCount
} from "../../utils/unityRegistry";

const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

// Any logged-in account can open this socket, and what a master sends is stored and fanned out to every other
// device (and to APNs), so the socket needs limits of its own. A `state` carries the whole queue and history -
// legitimately large - so it gets a roomy cap; everything else is a few bytes.
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
// the master reports once a second and a person can't issue commands faster than a few per second; this only
// has to stop a loop
const MAX_MESSAGES_PER_SECOND = 30;
const MAX_SOCKETS_PER_USER = 8;
const ACTION_NAME = /^[A-Za-z]{1,32}$/;

interface PeerContext {
    userId: string,
    sessionId: string,
    deviceLabel: string,
    lastActivity: number,
    heartbeat: NodeJS.Timeout,
    windowStart: number,
    windowCount: number
}

export default defineWebSocketHandler({
    async open(peer) {
        // Unity's live registry is in-process only (see server/utils/unityRegistry.ts) - an operator running
        // more than one Nitro instance behind a load balancer should turn this off explicitly rather than
        // have it silently half-work depending on which instance a given device lands on.
        if (process.env.NAFYN_UNITY_ENABLED === "false") {
            peer.close(4002, "Nafyn Unity is disabled on this server");
            return;
        }

        const url = new URL(peer.request.url, "http://localhost");
        const rawToken = url.searchParams.get("token");

        if (!rawToken) {
            peer.close(4000, "Missing token");
            return;
        }

        const token = rawToken.startsWith("Bearer ") ? rawToken.slice("Bearer ".length) : rawToken;

        let userId: string;
        let sessionId: string;
        try {
            const payload = await verifyAuthToken(token);
            userId = payload.sub;
            sessionId = payload.jti;
        } catch {
            peer.close(4001, "Invalid or expired token");
            return;
        }

        // a browser tab left reconnecting in a loop, or something hostile, must not pile up sockets (each one
        // carries a timer and a place in the registry)
        if (connectionCount(userId) >= MAX_SOCKETS_PER_USER) {
            peer.close(4009, "Too many connections for this account");
            return;
        }

        const deviceLabel = labelUserAgent(peer.request.headers.get("user-agent"));
        const now = Date.now();

        const heartbeat = setInterval(() => {
            const ctx = peer.context.unity as PeerContext | undefined;
            if (!ctx) return;
            if (Date.now() - ctx.lastActivity > HEARTBEAT_TIMEOUT_MS) {
                peer.close(4008, "Heartbeat timeout");
                return;
            }
            peer.send(JSON.stringify({ type: "ping" }));
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();

        peer.context.unity = { userId, sessionId, deviceLabel, lastActivity: now, heartbeat, windowStart: now, windowCount: 0 } satisfies PeerContext;

        registerConnection(userId, peer, sessionId, deviceLabel);
        peer.send(JSON.stringify({ type: "snapshot", ...getSnapshot(userId, peer) }));
    },

    message(peer, message) {
        const ctx = peer.context.unity as PeerContext | undefined;
        if (!ctx) return;

        const now = Date.now();
        ctx.lastActivity = now;

        if (now - ctx.windowStart >= 1000) {
            ctx.windowStart = now;
            ctx.windowCount = 0;
        }
        if (++ctx.windowCount > MAX_MESSAGES_PER_SECOND) {
            // a flood is dropped, and a socket that keeps flooding is closed
            if (ctx.windowCount > MAX_MESSAGES_PER_SECOND * 4) peer.close(4010, "Too many messages");
            return;
        }

        const text = message.text();
        if (text.length > MAX_STATE_BYTES) return;

        let data: { type: string, [key: string]: unknown };
        try {
            data = JSON.parse(text);
        } catch {
            return;
        }
        if (!data || typeof data !== "object" || typeof data.type !== "string") return;
        if (data.type !== "state" && text.length > MAX_MESSAGE_BYTES) return;

        switch (data.type) {
            case "pong":
                return;
            case "claim-master": {
                const granted = claimMaster(ctx.userId, peer, ctx.sessionId, ctx.deviceLabel);
                peer.send(JSON.stringify(granted ? { type: "claim-granted" } : { type: "claim-rejected", reason: "A master is already active" }));
                return;
            }
            case "takeover":
                takeoverMaster(ctx.userId, peer, ctx.sessionId, ctx.deviceLabel);
                return;
            case "state":
                applyState(ctx.userId, peer, data.state);
                return;
            case "command": {
                // the server never interprets a command, but it does refuse anything that isn't a plain method name
                // with an array of arguments - the receiving browser calls `player[action](...payload)`
                if (typeof data.action !== "string" || !ACTION_NAME.test(data.action) || !Array.isArray(data.payload)) return;
                const ok = forwardCommand(ctx.userId, data.action, data.payload);
                if (!ok) peer.send(JSON.stringify({ type: "error", code: "no-master", message: "No master device is currently active" }));
                return;
            }
            default:
                return;
        }
    },

    close(peer) {
        const ctx = peer.context.unity as PeerContext | undefined;
        if (!ctx) return;
        clearInterval(ctx.heartbeat);
        handleClose(ctx.userId, peer);
    }
});
