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
    handleClose
} from "../../utils/unityRegistry";

const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

interface PeerContext {
    userId: string,
    sessionId: string,
    deviceLabel: string,
    lastActivity: number,
    heartbeat: NodeJS.Timeout
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

        peer.context.unity = { userId, sessionId, deviceLabel, lastActivity: now, heartbeat } satisfies PeerContext;

        registerConnection(userId, peer, sessionId, deviceLabel);
        peer.send(JSON.stringify({ type: "snapshot", ...getSnapshot(userId, peer) }));
    },

    message(peer, message) {
        const ctx = peer.context.unity as PeerContext | undefined;
        if (!ctx) return;

        ctx.lastActivity = Date.now();

        let data: { type: string, [key: string]: unknown };
        try {
            data = JSON.parse(message.text());
        } catch {
            return;
        }

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
                const ok = forwardCommand(ctx.userId, data.action as string, data.payload);
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
