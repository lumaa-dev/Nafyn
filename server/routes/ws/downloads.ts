// live download progress: connect with `?requestId=<id>&token=<jwt>`
// (browsers can't set custom headers on a WebSocket handshake, so the token travels as a query param instead of `Authorization`)
import { verifyAuthToken } from "../../utils/jwt";
import { getRequestById } from "../../core/requests";
import { onDownloadProgress } from "../../utils/downloadEvents";

export default defineWebSocketHandler({
    async open(peer) {
        const url = new URL(peer.request.url, "http://localhost");
        const token = url.searchParams.get("token");
        const requestId = url.searchParams.get("requestId");

        if (!token || !requestId) {
            peer.close(4000, "Missing token or requestId");
            return;
        }

        let userId: string;
        try {
            userId = verifyAuthToken(token).sub;
        } catch {
            peer.close(4001, "Invalid or expired token");
            return;
        }

        const request = await getRequestById(requestId);
        if (!request || request.requestedBy !== userId) {
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
