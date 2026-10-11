// Nafyn Unity: in-process master/slave bookkeeping for one user's connected devices, consumed by the
// `ws/unity` route. Lives purely in memory, same single-process limitation `downloadEvents.ts` already has
// (see CLAUDE.md's Unity paragraph) - correctness here means a consistent in-process registry, not
// durability across a restart, since every live WS connection is dropped by a restart anyway.
//
// The server never interprets the `state` payload a master broadcasts - it's opaque, relayed verbatim to
// slaves. Only the master's own browser knows how to turn a `command` back into an actual player mutation;
// the server's job is strictly: who is master, what did they last report, and grace-period timing.
import type { Peer } from "crossws";

export type UnityStatus = "active" | "grace" | "empty";

interface Connection {
    peer: Peer,
    sessionId: string,
    deviceLabel: string
}

interface UnitySession {
    master: Connection | null,
    slaves: Map<Peer, Connection>,
    lastState: unknown,
    status: UnityStatus,
    graceTimer: NodeJS.Timeout | null
}

const GRACE_PERIOD_MS = 30_000;

const sessions = new Map<string, UnitySession>();

function getOrCreateSession(userId: string): UnitySession {
    let session = sessions.get(userId);
    if (!session) {
        session = { master: null, slaves: new Map(), lastState: null, status: "empty", graceTimer: null };
        sessions.set(userId, session);
    }
    return session;
}

// drops the registry entry entirely once nothing's connected and nothing's playing, so it doesn't leak one
// entry per user forever
function cleanupIfEmpty(userId: string, session: UnitySession): void {
    if (session.master === null && session.slaves.size === 0 && session.status !== "grace") {
        sessions.delete(userId);
    }
}

function broadcastToSlaves(session: UnitySession, message: unknown): void {
    const payload = JSON.stringify(message);
    for (const { peer } of session.slaves.values()) {
        peer.send(payload);
    }
}

export function getSnapshot(userId: string, forPeer: Peer): { role: "master" | "slave", state: unknown, masterDeviceLabel: string | null, masterStatus: UnityStatus } {
    const session = sessions.get(userId);
    if (!session) return { role: "slave", state: null, masterDeviceLabel: null, masterStatus: "empty" };
    return {
        role: session.master?.peer === forPeer ? "master" : "slave",
        state: session.lastState,
        masterDeviceLabel: session.master?.deviceLabel ?? null,
        masterStatus: session.status
    };
}

export function registerConnection(userId: string, peer: Peer, sessionId: string, deviceLabel: string): void {
    const session = getOrCreateSession(userId);
    // a reconnect from the same session within the grace window resumes as master rather than joining as a
    // new slave - this is what makes a brief network blip/backgrounded tab invisible to everyone else
    if (session.status === "grace" && session.master?.sessionId === sessionId) {
        if (session.graceTimer) clearTimeout(session.graceTimer);
        session.graceTimer = null;
        session.master = { peer, sessionId, deviceLabel };
        session.status = "active";
        return;
    }
    session.slaves.set(peer, { peer, sessionId, deviceLabel });
}

export function claimMaster(userId: string, peer: Peer, sessionId: string, deviceLabel: string): boolean {
    const session = getOrCreateSession(userId);
    if (session.master !== null) return false;

    session.slaves.delete(peer);
    session.master = { peer, sessionId, deviceLabel };
    session.status = "active";
    peer.send(JSON.stringify({ type: "master-changed", youAreMaster: true, deviceLabel }));
    broadcastToSlaves(session, { type: "master-changed", youAreMaster: false, deviceLabel });
    return true;
}

export function takeoverMaster(userId: string, peer: Peer, sessionId: string, deviceLabel: string): void {
    const session = getOrCreateSession(userId);
    const previous = session.master;

    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = null;

    // notify the slaves that were already slaves first, before the demoted former master (if any) joins
    // that set below - otherwise it would receive this same broadcast a second time
    session.slaves.delete(peer);
    broadcastToSlaves(session, { type: "master-changed", youAreMaster: false, deviceLabel });

    if (previous && previous.peer !== peer) {
        // `previous` can be a stale reference to an already-closed socket when the takeover happens during
        // its own grace period - sending to it is best-effort, not a correctness requirement
        try {
            previous.peer.send(JSON.stringify({ type: "master-changed", youAreMaster: false, deviceLabel }));
        } catch {
            // ignore
        }
        session.slaves.set(previous.peer, previous);
    }

    session.master = { peer, sessionId, deviceLabel };
    session.status = "active";
    session.lastState = null;
    peer.send(JSON.stringify({ type: "master-changed", youAreMaster: true, deviceLabel }));
}

export function applyState(userId: string, peer: Peer, state: unknown): void {
    const session = sessions.get(userId);
    if (!session || session.master?.peer !== peer) return;

    session.lastState = state;
    broadcastToSlaves(session, { type: "state", state });
}

export function forwardCommand(userId: string, action: string, payload: unknown): boolean {
    const session = sessions.get(userId);
    // "grace" still holds a master reference (a stale/closed peer, kept only so a same-session reconnect can
    // resume it) - a command has nowhere live to go until either that reconnect happens or the grace period
    // clears it, so this must not attempt to send down a socket that's already gone
    if (!session || !session.master || session.status !== "active") return false;

    session.master.peer.send(JSON.stringify({ type: "command", action, payload }));
    return true;
}

export function handleClose(userId: string, peer: Peer): void {
    const session = sessions.get(userId);
    if (!session) return;

    if (session.master?.peer === peer) {
        session.status = "grace";
        broadcastToSlaves(session, { type: "master-disconnected", gracePeriodMs: GRACE_PERIOD_MS });

        session.graceTimer = setTimeout(() => {
            session.master = null;
            session.lastState = null;
            session.status = "empty";
            session.graceTimer = null;
            broadcastToSlaves(session, { type: "master-cleared" });
            cleanupIfEmpty(userId, session);
        }, GRACE_PERIOD_MS);
        session.graceTimer.unref?.();
    } else {
        session.slaves.delete(peer);
    }

    cleanupIfEmpty(userId, session);
}

// called when a session is revoked (Settings -> Sessions, or logout) so an already-open socket riding that
// session can't keep controlling playback until it happens to make its next HTTP call and gets a 401
export function closeUnityConnectionsForSession(userId: string, sessionId: string): void {
    const session = sessions.get(userId);
    if (!session) return;

    if (session.master?.sessionId === sessionId) {
        session.master.peer.close(4003, "Session revoked");
    }
    for (const slave of session.slaves.values()) {
        if (slave.sessionId === sessionId) slave.peer.close(4003, "Session revoked");
    }
}
