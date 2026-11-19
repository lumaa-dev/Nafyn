// Firebase Cloud Messaging (HTTP v1) transport for the Nafyn Android app.
//
// Like APNs, a silent no-op until configured: FCM_SERVICE_ACCOUNT_FILE points at the service-account JSON of
// the Firebase project the Android app was built with (Firebase console -> Project settings -> Service
// accounts -> Generate new private key). The OAuth access token is minted here from that key (RS256 JWT
// bearer grant, signed with `jsonwebtoken`), so no Google SDK is needed. Payload shapes are in fcmPayload.ts;
// who gets what is decided by apn.ts, which dispatches to both platforms.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { isDeadFcmToken, isThrottledFcm, fcmErrorCode, type FcmErrorBody, type FcmMessage } from "./fcmPayload";

// fixed Google endpoints: never taken from the key file, so a tampered file can't point the server elsewhere
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const SEND_TIMEOUT_MS = 15_000;

interface ServiceAccount {
    type?: string,
    project_id?: string,
    client_email?: string,
    private_key?: string
}

export interface FcmSettings {
    file: string,
    path: string | null,
    /** null when the file can't be read or parsed */
    projectId: string | null,
    clientEmail: string | null,
    problem: string | null
}

let accountCache: { path: string, account: ServiceAccount | null, problem: string | null } | undefined;

function configuredFile(): string {
    return (process.env.FCM_SERVICE_ACCOUNT_FILE ?? "").trim();
}

function loadAccount(): { path: string | null, account: ServiceAccount | null, problem: string | null } {
    const file = configuredFile();
    if (!file) return { path: null, account: null, problem: null };
    const path = resolve(process.cwd(), file);
    if (accountCache?.path === path) return accountCache;

    let account: ServiceAccount | null = null;
    let problem: string | null = null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as ServiceAccount;
        if (parsed.type !== "service_account") problem = "the file is not a service-account key (\"type\" is not \"service_account\")";
        else if (!parsed.project_id) problem = "the file has no project_id";
        else if (!parsed.client_email) problem = "the file has no client_email";
        else if (!parsed.private_key?.includes("PRIVATE KEY")) problem = "the file has no private_key";
        else account = parsed;
    } catch (err) {
        problem = err instanceof SyntaxError ? "the file is not valid JSON" : "the file can't be read";
    }
    accountCache = { path, account, problem };
    return accountCache;
}

/** true once a readable service-account key is configured */
export function fcmEnabled(): boolean {
    return loadAccount().account !== null;
}

/** the effective FCM settings - for diagnostics (envCheck.ts, scripts/fcm-test.ts); never the key itself */
export function fcmSettings(): FcmSettings {
    const { path, account, problem } = loadAccount();
    return {
        file: configuredFile(),
        path,
        projectId: account?.project_id ?? null,
        clientEmail: account?.client_email ?? null,
        problem
    };
}

let accessToken: { value: string, expiresAt: number } | null = null;
let pendingToken: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
    if (accessToken && accessToken.expiresAt - 60_000 > Date.now()) return accessToken.value;
    if (pendingToken) return pendingToken;

    pendingToken = (async () => {
        const account = loadAccount().account;
        if (!account) throw new Error("FCM is not configured");
        const now = Math.floor(Date.now() / 1000);
        const assertion = jwt.sign(
            { iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
            account.private_key!,
            { algorithm: "RS256" }
        );
        const response = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
            redirect: "error",
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        });
        const body = await response.json().catch(() => null) as { access_token?: string, expires_in?: number, error?: string, error_description?: string } | null;
        if (!response.ok || !body?.access_token) {
            throw new Error(`Google refused the service-account key: ${body?.error_description ?? body?.error ?? response.status}`);
        }
        accessToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
        return accessToken.value;
    })().finally(() => { pendingToken = null; });
    return pendingToken;
}

export interface FcmSendResult {
    token: string,
    ok: boolean,
    status: number | null,
    /** FCM's error code (UNREGISTERED, QUOTA_EXCEEDED, ...) or a transport error message */
    reason: string | null,
    dead: boolean,
    throttled: boolean
}

/** Sends one message to one token. Never throws. */
export async function sendFcm(token: string, message: FcmMessage): Promise<FcmSendResult> {
    const base = { token, ok: false, status: null, reason: null, dead: false, throttled: false };
    const account = loadAccount().account;
    if (!account) return { ...base, reason: "NotConfigured" };
    try {
        const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id!)}/messages:send`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message: { token, ...message } }),
            redirect: "error",
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        });
        if (response.ok) return { ...base, ok: true, status: response.status };
        const body = await response.json().catch(() => null) as FcmErrorBody | null;
        // an expired/revoked access token: mint a new one next time
        if (response.status === 401) accessToken = null;
        return {
            ...base,
            status: response.status,
            reason: fcmErrorCode(body) ?? body?.error?.message ?? String(response.status),
            dead: isDeadFcmToken(response.status, body),
            throttled: isThrottledFcm(response.status, body)
        };
    } catch (err) {
        return { ...base, reason: err instanceof Error ? err.message : "Unknown error" };
    }
}

// FCM's errors, with what usually causes each one in a Nafyn setup (scripts/fcm-test.ts)
export const FCM_FAILURE_HINTS: Record<string, string> = {
    NotConfigured: "FCM_SERVICE_ACCOUNT_FILE is not set or the file is not a valid service-account key. Run `bun run check:env`.",
    UNREGISTERED: "The app was uninstalled, or its token was rotated. Open the app again so it registers a new one.",
    SENDER_ID_MISMATCH: "The token belongs to another Firebase project than the service-account key. The app's google-services.json and FCM_SERVICE_ACCOUNT_FILE must come from the same project.",
    INVALID_ARGUMENT: "The token is malformed (or the payload is invalid).",
    THIRD_PARTY_AUTH_ERROR: "Only matters for iOS through FCM, which Nafyn does not use.",
    QUOTA_EXCEEDED: "Sending too fast. Wait a little.",
    UNAVAILABLE: "Google-side error, try again.",
    INTERNAL: "Google-side error, try again.",
    PERMISSION_DENIED: "The service account may not send messages: give it the \"Firebase Cloud Messaging API Admin\" role, and check the \"Firebase Cloud Messaging API (V1)\" is enabled for the project."
};
