// in-memory state for connecting a streaming account: pending OAuth `state`s and connected sessions.
//
// Deliberately never persisted. A provider access token is only needed for the minutes it takes to read the
// source library, so it lives here with a short TTL and is dropped as soon as that read is done; a restart
// simply means connecting again. (With several Nafyn replicas, the OAuth callback must reach the replica
// that started it - sticky sessions, or a single replica serving /api/v1/transfer.)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { H3Event } from "h3";
import type { TransferProviderId } from "~~/server/entity/Transfer";
import type { ProviderSession } from "./types";
import { trustedProxyHops } from "../clientIp";

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_PER_USER = 5;

interface PendingAuth {
    userId: string,
    provider: TransferProviderId,
    codeVerifier: string,
    redirectUri: string,
    expiresAt: number
}

const pending = new Map<string, PendingAuth>();
const sessions = new Map<string, ProviderSession>();

function sweep() {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
    for (const [key, value] of sessions) if (value.expiresAt <= now) sessions.delete(key);
}

// where providers send the user back to. NAFYN_PUBLIC_URL wins; otherwise the request's own origin, with
// forwarded host/proto only honoured behind a declared proxy (same rule as clientIp.ts)
export function transferRedirectUri(event: H3Event): string {
    const configured = useRuntimeConfig().transfer.publicUrl.replace(/\/+$/, "");
    const trusted = trustedProxyHops() > 0;
    const origin = configured || getRequestURL(event, { xForwardedHost: trusted, xForwardedProto: trusted }).origin;
    return `${origin}/transfer/callback`;
}

export function createPendingAuth(userId: string, provider: TransferProviderId, redirectUri: string): { state: string, codeChallenge: string } {
    sweep();

    // a user mashing "connect" shouldn't be able to grow this map without bound
    const mine = [...pending.entries()].filter(([, p]) => p.userId === userId).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    while (mine.length >= MAX_PENDING_PER_USER) pending.delete(mine.shift()![0]);

    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    pending.set(state, { userId, provider, codeVerifier, redirectUri, expiresAt: Date.now() + STATE_TTL_MS });
    return { state, codeChallenge };
}

// single use, and only by the account that started it - a leaked callback URL can't be replayed by anyone else
export function consumePendingAuth(state: string, userId: string): PendingAuth | null {
    sweep();
    const entry = pending.get(state);
    if (!entry || entry.userId !== userId) return null;
    pending.delete(state);
    return entry;
}

export function createTransferSession(userId: string, provider: TransferProviderId, accessToken: string | null, expiresInSeconds: number | null, data: Record<string, string> = {}): ProviderSession {
    sweep();

    // one connected account per user at a time
    for (const [key, value] of sessions) if (value.userId === userId) sessions.delete(key);

    const ttl = expiresInSeconds ? Math.min(SESSION_TTL_MS, expiresInSeconds * 1000) : SESSION_TTL_MS;
    const session: ProviderSession = {
        id: randomUUID(),
        userId,
        provider,
        accessToken,
        data,
        playlists: new Map(),
        expiresAt: Date.now() + ttl
    };
    sessions.set(session.id, session);
    return session;
}

export function getTransferSession(id: unknown, userId: string): ProviderSession | null {
    sweep();
    if (typeof id !== "string") return null;
    const session = sessions.get(id);
    return session && session.userId === userId ? session : null;
}

export function dropTransferSession(id: string): void {
    sessions.delete(id);
}
