// live download progress: connect with `?requestId=<id>&token=<jwt>`
// (browsers can't set custom headers on a WebSocket handshake, so the token travels as a query param instead of `Authorization`)
import { verifyAuthToken } from "../../utils/jwt";
import { getRequestById } from "../../core/requests";
import { onDownloadProgress } from "../../utils/downloadEvents";

// one open page of requests holds one socket per live request; this only stops a runaway client (or a loop
// reconnecting forever) from holding thousands
const MAX_SOCKETS_PER_USER = 60;
const socketsPerUser = new Map<string, number>();

interface DownloadPeerContext {
    userId?: string,
    closed?: boolean,
    unsubscribe?: () => void
}

export default defineWebSocketHandler({
    async open(peer) {
        const ctx = peer.context as DownloadPeerContext;
        const url = new URL(peer.request.url, "http://localhost");
        const rawToken = url.searchParams.get("token");
        const requestId = url.searchParams.get("requestId");

        if (!rawToken || !requestId) {
            peer.close(4000, "Missing token or requestId");
            return;
        }

        // the `nafynToken` cookie is stored (and sent everywhere else) as `Bearer <jwt>`; strip that prefix
        // here too, the same way requireAuthToken does for the Authorization header on regular HTTP routes
        const token = rawToken.startsWith("Bearer ") ? rawToken.slice("Bearer ".length) : rawToken;

        let userId: string;
        try {
            userId = (await verifyAuthToken(token)).sub;
        } catch {
            peer.close(4001, "Invalid or expired token");
            return;
        }

        const request = await getRequestById(requestId);
        // the peer may have gone away during the two awaits above; subscribing now would be a listener nobody
        // ever removes, because close() has already run
        if (ctx.closed) return;
        // requestedBy is resolved to a full NafynUser object whenever that user still exists, so it can't
        // be compared to the raw `userId` string directly - only fall back to it as a plain UUID otherwise
        const requestedById = typeof request?.requestedBy === "string" ? request.requestedBy : request?.requestedBy?.id;
        if (!request || requestedById !== userId) {
            peer.close(4004, "Request not found");
            return;
        }

        const open = socketsPerUser.get(userId) ?? 0;
        if (open >= MAX_SOCKETS_PER_USER) {
            peer.close(4009, "Too many open connections");
            return;
        }
        socketsPerUser.set(userId, open + 1);
        ctx.userId = userId;

        ctx.unsubscribe = onDownloadProgress(requestId, (event) => {
            try {
                peer.send(JSON.stringify(event));
            } catch {
                // a dead socket: close() will unsubscribe it
            }
        });
    },
    close(peer) {
        const ctx = peer.context as DownloadPeerContext;
        ctx.closed = true;
        ctx.unsubscribe?.();
        ctx.unsubscribe = undefined;

        if (ctx.userId) {
            const left = (socketsPerUser.get(ctx.userId) ?? 1) - 1;
            if (left <= 0) socketsPerUser.delete(ctx.userId);
            else socketsPerUser.set(ctx.userId, left);
            ctx.userId = undefined;
        }
    }
});
