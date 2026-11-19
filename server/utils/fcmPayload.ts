// Firebase Cloud Messaging payloads for the Nafyn Android app (NafynAndroid). Pure: no Nitro auto-imports, no
// network, so tests/push/ runs it under `bun test`.
//
// Every message is a *data-only* message: the app builds the notification itself (localized strings, its own
// channels, Live Updates, the Now Playing media notification), the way the iOS app reads `loc-key`s. FCM data
// values must be strings, so everything but `type`/`event`/`refId` travels JSON-encoded in `payload`. This is
// the contract with NafynAndroid's `NafynMessagingService` - change both sides together (CLAUDE.md,
// "Notifications").
//
//   type              event                 payload
//   alert             -                     PushAlert (title, body, locKey, locArgs, threadId, category, imageUrl, data)
//   request-activity  start|update|end      { attributes?, state, alert?, dismissAt? }   refId = request id
//   release-activity  start|end             { attributes?, state, alert?, staleAt?, dismissAt? } refId = subscription id
//   nowplaying        start|update|end      NowPlaying attributes                         refId = session id
//   test              -                     { title, body }
//
// Times in `dismissAt`/`staleAt` are UNIX milliseconds; inside `state` they keep the iOS shape (a release's
// `releaseAt` is UNIX seconds) so both apps read one content-state.

export type PushPlatform = "ios" | "android";
export const PUSH_PLATFORMS = ["ios", "android"] as const;

/** the alert both platforms show; iOS turns it into `aps.alert`, Android into a notification */
export interface PushAlert {
    /** English fallback, also what a client without the localization keys shows */
    title: string,
    body: string,
    /** string keys in the apps; when set the app shows the localized text instead */
    titleLocKey?: string,
    locKey?: string,
    locArgs?: string[],
    /** groups related notifications (e.g. every update about one request) */
    threadId?: string,
    category?: string,
    /** cover art, attached to the notification by the app */
    imageUrl?: string | null,
    /** deep-link details */
    data?: Record<string, unknown>
}

export interface FcmAndroidConfig {
    priority: "high" | "normal",
    /** protobuf Duration, e.g. "3600s" */
    ttl?: string,
    collapse_key?: string
}

/** the `message` of an FCM HTTP v1 send, minus the `token` */
export interface FcmMessage {
    data: Record<string, string>,
    android: FcmAndroidConfig
}

export type FcmActivityKind = "request" | "release";

export interface FcmActivityInput {
    kind: FcmActivityKind,
    /** request id / release subscription id: what the app keys its notification on */
    refId: string,
    event: "start" | "update" | "end",
    contentState: object,
    attributes?: object,
    alert?: { title: string, body: string },
    staleDateMs?: number,
    dismissalDateMs?: number,
    /** APNs-style priority: 10 = now, 5 = may wait. Maps to FCM high / normal. */
    priority?: number
}

// an FCM token is an opaque string of URL-safe base64 and ":" (about 160 characters today); APNs tokens are hex
const FCM_TOKEN_RE = /^[A-Za-z0-9_:\-]{32,500}$/;
const APN_TOKEN_RE = /^[0-9a-fA-F]{64,400}$/;

export function isPushPlatform(value: unknown): value is PushPlatform {
    return value === "ios" || value === "android";
}

export function isValidPushToken(platform: PushPlatform, token: unknown): token is string {
    if (typeof token !== "string") return false;
    return platform === "android" ? FCM_TOKEN_RE.test(token) : APN_TOKEN_RE.test(token);
}

/** APNs tokens are case-insensitive hex and stored lowercased; FCM tokens are case-sensitive and kept as they are */
export function normalizePushToken(platform: PushPlatform, token: string): string {
    return platform === "ios" ? token.toLowerCase() : token;
}

function stripUndefined<T extends object>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function message(data: Record<string, string | undefined>, android: FcmAndroidConfig): FcmMessage {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) if (value !== undefined) clean[key] = value;
    return { data: clean, android };
}

export function fcmAlertMessage(alert: PushAlert): FcmMessage {
    return message({
        type: "alert",
        event: typeof alert.data?.event === "string" ? alert.data.event : undefined,
        payload: JSON.stringify(stripUndefined({ ...alert, imageUrl: alert.imageUrl ?? undefined }))
    }, { priority: "high", ttl: "86400s" });
}

export function fcmActivityMessage(input: FcmActivityInput): FcmMessage {
    const urgent = (input.priority ?? 10) >= 10 || input.event !== "update";
    return message({
        type: `${input.kind}-activity`,
        event: input.event,
        refId: input.refId,
        payload: JSON.stringify(stripUndefined({
            attributes: input.attributes,
            state: input.contentState,
            alert: input.alert,
            staleAt: input.staleDateMs,
            dismissAt: input.dismissalDateMs
        }))
    }, {
        priority: urgent ? "high" : "normal",
        // progress is worthless once stale; a start/end may wait a little longer for a device coming back online
        ttl: urgent ? "3600s" : "60s",
        // an undelivered update is replaced by a newer one for the same activity
        collapse_key: `${input.kind}-${input.refId}`
    });
}

export function fcmNowPlayingMessage(event: "start" | "update" | "end", attributes: { id: string } & object): FcmMessage {
    return message({
        type: "nowplaying",
        event,
        refId: attributes.id,
        payload: JSON.stringify(stripUndefined(attributes))
    }, { priority: "high", ttl: "120s", collapse_key: `nowplaying-${attributes.id}` });
}

export function fcmTestMessage(text: string): FcmMessage {
    return message({ type: "test", payload: JSON.stringify({ title: "Nafyn", body: text }) }, { priority: "high", ttl: "600s" });
}

// FCM HTTP v1 errors (google.rpc.Status + FcmError details) meaning "this token will never work again"
export interface FcmErrorBody {
    error?: {
        code?: number,
        status?: string,
        message?: string,
        details?: { "@type"?: string, errorCode?: string }[]
    }
}

export function fcmErrorCode(body: FcmErrorBody | null | undefined): string | null {
    const detail = body?.error?.details?.find((d) => typeof d?.errorCode === "string");
    return detail?.errorCode ?? body?.error?.status ?? null;
}

/** true when the token is dead (uninstalled app, rotated token, other Firebase project) and its rows should go */
export function isDeadFcmToken(status: number, body: FcmErrorBody | null | undefined): boolean {
    const code = fcmErrorCode(body);
    if (code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH") return true;
    if (status === 404) return true;
    // INVALID_ARGUMENT is also what a malformed *payload* gets; only a complaint about the token kills it
    return status === 400 && code === "INVALID_ARGUMENT" && /registration token/i.test(body?.error?.message ?? "");
}

export function isThrottledFcm(status: number, body: FcmErrorBody | null | undefined): boolean {
    const code = fcmErrorCode(body);
    return status === 429 || status === 503 || code === "QUOTA_EXCEEDED" || code === "UNAVAILABLE" || code === "INTERNAL";
}
