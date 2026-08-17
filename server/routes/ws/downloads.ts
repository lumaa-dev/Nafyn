// live download progress: connect with `?requestId=<id>&token=<jwt>`
// (browsers can't set custom headers on a WebSocket handshake, so the token travels as a query param instead of `Authorization`)
import { verifyAuthToken } from "../../utils/jwt";
import { getRequestById } from "../../core/requests";
import { onDownloadProgress } from "../../utils/downloadEvents";

export default defineWebSocketHandler({
    async open(peer) {
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
            userId = verifyAuthToken(token).sub;
        } catch {
            peer.close(4001, "Invalid or expired token");
            return;
        }

        const request = await getRequestById(requestId);
        // requestedBy is resolved to a full NafynUser object whenever that user still exists, so it can't
        // be compared to the raw `userId` string directly - only fall back to it as a plain UUID otherwise
        const requestedById = typeof request?.requestedBy === "string" ? request.requestedBy : request?.requestedBy?.id;
        if (!request || requestedById !== userId) {
            peer.close(4004, "Request not found");
            return;
        }

        peer.context.unsubscribe = onDownloadProgress(requestId, (event) => {
            peer.send(JSON.stringify(event));
        });
    },
    close(peer) {
        const unsubscribe = peer.context.unsubscribe as (() => void) | undefined;
        unsubscribe?.();
    }
});
