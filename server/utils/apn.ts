// Apple Push Notification service: token storage, alerts, Live Activities and Now Playing remote sessions.
//
// Everything here is a silent no-op until APNs is configured (APN_KEY_ID + APN_TEAM_ID + a .p8 key) - the same
// "not configured means skipped, never an error" contract as the optional metadata providers. Nothing in this
// file can be exercised without an Apple device, so the payload shapes below are the contract with the Nafyn
// iOS app and are documented in CLAUDE.md ("Notifications"); change them on both sides at once.
//
// Token kinds (apn_devices.kind) - push-to-start tokens are minted per ActivityKit attributes type, so each
// startable thing needs its own:
//   alert             regular device token (UIApplication.registerForRemoteNotifications)
//   la-start:request  Activity<NafynRequestActivityAttributes>.pushToStartTokenUpdates
//   la-start:release  Activity<NafynReleaseCountdownAttributes>.pushToStartTokenUpdates
//   nowplaying-start  RemoteMediaSession<…>.pushToStartTokenUpdates (iOS 27)
// Once started, each activity/session hands the app a token addressing only it; the app sends that back with
// POST /api/v1/user/activities and it lands in apn_activity_tokens (kind request|release|nowplaying, refId).
//
// Tokens are bound to the login that registered them (sessionId = JWT jti): logging out or revoking that
// session drops them (deleteApnDataForSession), so a phone that was signed out stops receiving pushes.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
    Notification,
    Provider,
    type NotificationPushType,
    type ResponseFailure
} from "@parse/node-apn";
import { getUsersDb } from "../core/db";
import { getUnitySettings } from "../core/unitySettings";
import type { NotificationEvent } from "../entity/Notification";
import type { DownloadProgressEvent } from "./downloadEvents";

const DEFAULT_APP_BUNDLE = "fr.lumaa.Nafyn";

export type ApnEnvironment = "sandbox" | "production";
export const APN_DEVICE_KINDS = ["alert", "la-start:request", "la-start:release", "nowplaying-start"] as const;
export type ApnDeviceKind = typeof APN_DEVICE_KINDS[number];
export const APN_ACTIVITY_KINDS = ["request", "release", "nowplaying"] as const;
export type ApnActivityKind = typeof APN_ACTIVITY_KINDS[number];

// ActivityKit attributes type names - must match the Swift struct names in the app, since a push-to-start
// payload names the type it starts by string
export const REQUEST_ACTIVITY_TYPE = "NafynRequestActivityAttributes";
export const RELEASE_ACTIVITY_TYPE = "NafynReleaseCountdownAttributes";

// how long a finished request's Live Activity stays on the lock screen
const REQUEST_ACTIVITY_LINGER_MS = 25 * 60 * 1000;
// how long the "out now" countdown stays up after release. iOS ends any Live Activity 8 hours after it
// started; the countdown starts 3 hours before release, so this always fits inside that window.
const RELEASE_ACTIVITY_LINGER_MS = 60 * 60 * 1000;
// Apple budgets Live Activity updates; anything that isn't a stage/track change waits at least this long
const REQUEST_UPDATE_MIN_INTERVAL_MS = 15_000;

// `nowplaying` isn't in node-apn's NotificationPushType union yet; the library copies `pushType` straight into
// the apns-push-type header (lib/notification/index.js), so widening the type locally is all it takes
type ApnPushType = NotificationPushType | "nowplaying";

// APNs reasons meaning "this token will never work again" - the row is deleted
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredToken"]);

// ---------------------------------------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------------------------------------

function env(name: string, legacy: string): string {
    return (process.env[name] ?? process.env[legacy] ?? "").trim();
}

function bundleId(): string {
    return env("APN_BUNDLE_ID", "APP_BUNDLE") || DEFAULT_APP_BUNDLE;
}

let keyPathCache: string | null | undefined;

function findP8file(): string | undefined {
    try {
        const keyDirectory = env("APN_KEY_DIR", "KEY_DIR") || ".";
        const projectRoot = resolve(process.cwd(), keyDirectory);
        const files = readdirSync(projectRoot);
        const p8files = files.filter((file) => file.endsWith(".p8"));

        if (p8files.length <= 0) {
            return;
        }

        // prefer the key whose name matches the configured key id (AuthKey_<KEYID>.p8)
        const keyId = env("APN_KEY_ID", "KEY_ID");
        const exact = p8files.find((file) => keyId && file === `AuthKey_${keyId}.p8`);
        if (exact) return resolve(projectRoot, exact);

        if (p8files.length > 1) {
            console.warn(`[apn] multiple .p8 files found: ${p8files.join(", ")}. Using the first one.`);
        }

        return resolve(projectRoot, p8files[0]!);
    } catch (err) {
        console.error("[apn] could not look for a .p8 key:", err);
        return;
    }
}

function keyPath(): string | null {
    if (keyPathCache === undefined) keyPathCache = findP8file() ?? null;
    return keyPathCache;
}

/** true once a key id, team id and .p8 key are all present */
export function apnEnabled(): boolean {
    return !!env("APN_KEY_ID", "KEY_ID") && !!env("APN_TEAM_ID", "TEAM_ID") && keyPath() !== null;
}

/** the effective APNs settings, as read from the environment - for diagnostics (envCheck.ts, scripts/apn-test.ts) */
export function apnSettings() {
    return {
        keyId: env("APN_KEY_ID", "KEY_ID"),
        teamId: env("APN_TEAM_ID", "TEAM_ID"),
        bundleId: bundleId(),
        keyDir: env("APN_KEY_DIR", "KEY_DIR") || ".",
        keyPath: keyPath(),
        legacyNames: ["KEY_ID", "TEAM_ID", "APP_BUNDLE", "KEY_DIR"].filter((name) => process.env[name] !== undefined)
    };
}

// one provider per APNs environment: a token minted by a development (Xcode) build is only valid against the
// sandbox gateway, a TestFlight/App Store one only against production - each token row says which it is
const providers = new Map<ApnEnvironment, Provider>();

function getProvider(environment: ApnEnvironment): Provider {
    let provider = providers.get(environment);
    if (!provider) {
        provider = new Provider({
            production: environment === "production",
            token: {
                key: keyPath()!,
                keyId: env("APN_KEY_ID", "KEY_ID"),
                teamId: env("APN_TEAM_ID", "TEAM_ID")
            }
        });
        providers.set(environment, provider);
    }
    return provider;
}

function defaultEnvironment(): ApnEnvironment {
    return process.env.APN_PRODUCTION === "true" ? "production" : "sandbox";
}

// ---------------------------------------------------------------------------------------------------------
// token storage
// ---------------------------------------------------------------------------------------------------------

interface DeviceRow {
    id: string,
    userId: string,
    sessionId: string,
    token: string,
    kind: ApnDeviceKind,
    environment: ApnEnvironment,
    deviceName: string | null,
    events: string | null,
    createdAt: number,
    lastSeenAt: number
}

interface ActivityTokenRow {
    id: string,
    userId: string,
    sessionId: string,
    kind: ApnActivityKind,
    refId: string,
    token: string,
    environment: ApnEnvironment,
    createdAt: number
}

/**
 * One physical Apple device, as the settings screen shows it. The iOS app registers up to four tokens per
 * device (alert, request Live Activities, release countdowns, Now Playing) - an implementation detail nobody
 * should have to manage separately - so they are folded into one entry per login (`sessionId`), the thing
 * that is actually 1:1 with an install. Removing the device removes every token behind it.
 */
export interface ApnDeviceSummary {
    /** the login's session id; what DELETE /api/v1/user/devices/{id} takes */
    id: string,
    deviceName: string | null,
    environment: ApnEnvironment,
    /** which push features this device registered for */
    kinds: ApnDeviceKind[],
    events: NotificationEvent[] | null,
    /** true when it was registered by the session making the request */
    currentSession: boolean,
    createdAt: number,
    lastSeenAt: number
}

interface ApnTarget {
    token: string,
    environment: ApnEnvironment
}

export class ApnInputError extends Error {}

// APNs device and push-to-start tokens are hex strings (32 bytes today, Apple reserves the right to grow them)
const TOKEN_RE = /^[0-9a-fA-F]{64,400}$/;

export function isValidApnToken(token: unknown): token is string {
    return typeof token === "string" && TOKEN_RE.test(token);
}

function parseEvents(raw: string | null): NotificationEvent[] | null {
    if (raw == null) return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function groupDevices(rows: DeviceRow[], currentSessionId?: string): ApnDeviceSummary[] {
    const bySession = new Map<string, DeviceRow[]>();
    for (const row of rows) {
        const group = bySession.get(row.sessionId) ?? [];
        group.push(row);
        bySession.set(row.sessionId, group);
    }

    return [...bySession.entries()].map(([sessionId, group]) => {
        // the alert token carries the user's event filter and is the one every device has; the rest follow it
        const primary = group.find((r) => r.kind === "alert") ?? group[0]!;
        const newestFirst = [...group].sort((a, b) => Number(b.lastSeenAt) - Number(a.lastSeenAt));
        return {
            id: sessionId,
            deviceName: newestFirst.find((r) => r.deviceName)?.deviceName ?? null,
            environment: primary.environment,
            kinds: [...new Set(group.map((r) => r.kind))],
            events: parseEvents(primary.events),
            currentSession: sessionId === currentSessionId,
            createdAt: Math.min(...group.map((r) => Number(r.createdAt))),
            lastSeenAt: Math.max(...group.map((r) => Number(r.lastSeenAt)))
        };
    }).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export interface RegisterDeviceInput {
    token: string,
    kind: ApnDeviceKind,
    environment: ApnEnvironment,
    deviceName: string | null,
    events: NotificationEvent[] | null
}

/**
 * Stores (or refreshes) a token for the calling login. Upserts on (token, kind): a token that shows up under a
 * different account (the device was signed into someone else) moves to that account instead of being shared.
 */
export async function registerDevice(userId: string, sessionId: string, input: RegisterDeviceInput): Promise<ApnDeviceSummary> {
    const now = Date.now();
    const db = getUsersDb();
    await db.prepare(`
        INSERT INTO apn_devices (id, userId, sessionId, token, kind, environment, deviceName, events, createdAt, lastSeenAt)
        VALUES (:id, :userId, :sessionId, :token, :kind, :environment, :deviceName, :events, :now, :now)
        ON DUPLICATE KEY UPDATE userId = VALUES(userId), sessionId = VALUES(sessionId), environment = VALUES(environment),
            deviceName = VALUES(deviceName), events = VALUES(events), lastSeenAt = VALUES(lastSeenAt)
    `).run({
        id: randomUUID(),
        userId,
        sessionId,
        token: input.token.toLowerCase(),
        kind: input.kind,
        environment: input.environment,
        deviceName: input.deviceName,
        events: input.events ? JSON.stringify(input.events) : null,
        now
    });

    const rows = await db.prepare(`SELECT * FROM apn_devices WHERE userId = ? AND sessionId = ?`).all(userId, sessionId) as DeviceRow[];
    return groupDevices(rows, sessionId)[0]!;
}

export async function listDevices(userId: string, currentSessionId?: string): Promise<ApnDeviceSummary[]> {
    const rows = await getUsersDb().prepare(`SELECT * FROM apn_devices WHERE userId = ? ORDER BY lastSeenAt DESC`).all(userId) as DeviceRow[];
    return groupDevices(rows, currentSessionId);
}

/** how many raw tokens the user has registered - what the per-user cap counts, not the device count */
export async function countDeviceTokens(userId: string): Promise<number> {
    const row = await getUsersDb().prepare(`SELECT COUNT(*) AS count FROM apn_devices WHERE userId = ?`).get(userId) as { count: number };
    return Number(row.count);
}

/** Removes a device (every token it registered, including running Live Activities and Now Playing). `id` is the device's session id. */
export async function deleteDevice(userId: string, id: string): Promise<boolean> {
    const db = getUsersDb();
    const tokens = await db.prepare(`DELETE FROM apn_devices WHERE userId = ? AND sessionId = ?`).run(userId, id);
    const activities = await db.prepare(`DELETE FROM apn_activity_tokens WHERE userId = ? AND sessionId = ?`).run(userId, id);
    return tokens.changes + activities.changes > 0;
}

/** Registers the update token of a running Live Activity / Now Playing session. Ownership of `refId` is the caller's job. */
export async function registerActivityToken(userId: string, sessionId: string, input: { kind: ApnActivityKind, refId: string, token: string, environment: ApnEnvironment }): Promise<void> {
    await getUsersDb().prepare(`
        INSERT INTO apn_activity_tokens (id, userId, sessionId, kind, refId, token, environment, createdAt)
        VALUES (:id, :userId, :sessionId, :kind, :refId, :token, :environment, :createdAt)
        ON DUPLICATE KEY UPDATE token = VALUES(token), environment = VALUES(environment), createdAt = VALUES(createdAt)
    `).run({
        id: randomUUID(),
        userId,
        sessionId,
        kind: input.kind,
        refId: input.refId,
        token: input.token.toLowerCase(),
        environment: input.environment,
        createdAt: Date.now()
    });
}

async function activityTargets(kind: ApnActivityKind, refId: string): Promise<ApnTarget[]> {
    return await getUsersDb().prepare(
        `SELECT token, environment FROM apn_activity_tokens WHERE kind = ? AND refId = ?`
    ).all(kind, refId) as ApnTarget[];
}

async function deleteActivityTokens(kind: ApnActivityKind, refId: string): Promise<void> {
    await getUsersDb().prepare(`DELETE FROM apn_activity_tokens WHERE kind = ? AND refId = ?`).run(kind, refId);
}

/** logout / session revoke: the device behind that login stops receiving anything */
export async function deleteApnDataForSession(sessionId: string): Promise<void> {
    const db = getUsersDb();
    await db.prepare(`DELETE FROM apn_devices WHERE sessionId = ?`).run(sessionId);
    await db.prepare(`DELETE FROM apn_activity_tokens WHERE sessionId = ?`).run(sessionId);
}

// erasure helper (GDPR art. 17)
export async function deleteApnDataForUser(userId: string): Promise<number> {
    const db = getUsersDb();
    const devices = await db.prepare(`DELETE FROM apn_devices WHERE userId = ?`).run(userId);
    await db.prepare(`DELETE FROM apn_activity_tokens WHERE userId = ?`).run(userId);
    return devices.changes;
}

// data-access export (GDPR art. 15): metadata only, tokens are credentials for pushing to that device
export async function listDeviceExportForUser(userId: string): Promise<{ kind: ApnDeviceKind, environment: ApnEnvironment, deviceName: string | null, events: NotificationEvent[] | null, createdAt: number, lastSeenAt: number }[]> {
    const rows = await getUsersDb().prepare(`SELECT * FROM apn_devices WHERE userId = ? ORDER BY createdAt ASC`).all(userId) as DeviceRow[];
    return rows.map(({ kind, environment, deviceName, events, createdAt, lastSeenAt }) => ({
        kind, environment, deviceName, events: parseEvents(events), createdAt: Number(createdAt), lastSeenAt: Number(lastSeenAt)
    }));
}

/**
 * Retention sweep (server/plugins/retentionJobs.ts): tokens whose login is gone (expired, revoked, deleted),
 * devices not seen in `staleDays`, and update tokens for activities that can no longer receive anything.
 */
export async function sweepApnTokens(staleDays: number): Promise<void> {
    const db = getUsersDb();
    const orphanFilter = `sessionId NOT IN (SELECT id FROM sessions WHERE revokedAt IS NULL)`;
    await db.prepare(`DELETE FROM apn_devices WHERE ${orphanFilter}`).run();
    await db.prepare(`DELETE FROM apn_activity_tokens WHERE ${orphanFilter}`).run();
    if (staleDays > 0) {
        await db.prepare(`DELETE FROM apn_devices WHERE lastSeenAt < ?`).run(Date.now() - staleDays * 86_400_000);
    }
    // finished requests and delivered release countdowns have already been sent their `end`
    await db.prepare(`
        DELETE FROM apn_activity_tokens WHERE kind = 'request'
          AND refId NOT IN (SELECT id FROM requests WHERE status NOT IN ('completed', 'failed', 'denied'))
    `).run();
    await db.prepare(`
        DELETE FROM apn_activity_tokens WHERE kind = 'release'
          AND refId NOT IN (SELECT id FROM release_subscriptions WHERE notifiedAt IS NULL OR notifiedAt > ?)
    `).run(Date.now() - 86_400_000);
    // Now Playing sessions live only in this process's memory; anything older than a day is long over
    await db.prepare(`DELETE FROM apn_activity_tokens WHERE kind = 'nowplaying' AND createdAt < ?`).run(Date.now() - 86_400_000);
}

async function deviceTargets(userIds: string[], kind: ApnDeviceKind, event?: NotificationEvent, excludeSessionId?: string): Promise<(ApnTarget & { sessionId: string })[]> {
    if (userIds.length === 0) return [];
    const placeholders = userIds.map(() => "?").join(", ");
    const rows = await getUsersDb().prepare(
        `SELECT token, environment, sessionId, events FROM apn_devices WHERE kind = ? AND userId IN (${placeholders})`
    ).all(kind, ...userIds) as (ApnTarget & { sessionId: string, events: string | null })[];
    return rows
        .filter((row) => row.sessionId !== excludeSessionId)
        .filter((row) => {
            if (!event) return true;
            const events = parseEvents(row.events);
            return events === null || events.includes(event);
        });
}

// ---------------------------------------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------------------------------------

async function pruneDeadTokens(failures: ResponseFailure[]): Promise<void> {
    const dead = failures
        .filter((f) => f.status === 410 || DEAD_TOKEN_REASONS.has(f.response?.reason ?? ""))
        .map((f) => f.device.toLowerCase());
    if (dead.length === 0) return;
    const placeholders = dead.map(() => "?").join(", ");
    const db = getUsersDb();
    await db.prepare(`DELETE FROM apn_devices WHERE token IN (${placeholders})`).run(...dead);
    await db.prepare(`DELETE FROM apn_activity_tokens WHERE token IN (${placeholders})`).run(...dead);
}

/** Sends one notification to every target, grouped by APNs environment. Never throws. */
async function send(targets: ApnTarget[], build: () => Notification, label: string): Promise<void> {
    if (!apnEnabled() || targets.length === 0) return;

    const byEnvironment = new Map<ApnEnvironment, string[]>();
    for (const { token, environment } of targets) {
        const list = byEnvironment.get(environment) ?? [];
        if (!list.includes(token)) list.push(token);
        byEnvironment.set(environment, list);
    }

    for (const [environment, tokens] of byEnvironment) {
        try {
            const result = await getProvider(environment).send(build(), tokens);
            if (result.failed.length > 0) {
                for (const failure of result.failed) {
                    console.warn(`[apn] ${label} to …${failure.device.slice(-8)} failed: ${failure.response?.reason ?? failure.error?.message ?? failure.status}`);
                }
                await pruneDeadTokens(result.failed);
            }
        } catch (err) {
            console.error(`[apn] ${label} (${environment}) failed:`, err);
        }
    }
}

function baseNotification(pushType: ApnPushType, topicSuffix: string | null, priority: number = 10): Notification {
    const notif = new Notification();
    notif.pushType = pushType as NotificationPushType;
    notif.topic = topicSuffix ? `${bundleId()}${topicSuffix}` : bundleId();
    notif.priority = priority;
    return notif;
}

const unixSeconds = (ms: number = Date.now()) => Math.floor(ms / 1000);

// ---------------------------------------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------------------------------------

export interface ApnAlert {
    /** English fallback, also what a client without the localization keys shows */
    title: string,
    body: string,
    /** Localizable.strings keys in the app; when set the system shows the localized text instead */
    titleLocKey?: string,
    locKey?: string,
    locArgs?: string[],
    /** groups related notifications (e.g. every update about one request) */
    threadId?: string,
    category?: string,
    /** cover art, for a Notification Service Extension to attach */
    imageUrl?: string | null,
    /** deep-link details, delivered under the top-level `nafyn` key */
    data?: Record<string, unknown>
}

function alertNotification(alert: ApnAlert): Notification {
    const notif = baseNotification("alert", null);
    notif.sound = "default";
    notif.aps.alert = {
        title: alert.title,
        body: alert.body,
        ...(alert.titleLocKey ? { "title-loc-key": alert.titleLocKey, "title-loc-args": alert.locArgs ?? [] } : {}),
        ...(alert.locKey ? { "loc-key": alert.locKey, "loc-args": alert.locArgs ?? [] } : {})
    };
    if (alert.threadId) notif.threadId = alert.threadId;
    if (alert.category) notif.aps.category = alert.category;
    if (alert.imageUrl) notif.aps["mutable-content"] = 1;
    notif.payload = { nafyn: { ...(alert.data ?? {}), imageUrl: alert.imageUrl ?? undefined } };
    return notif;
}

/** Sends an alert to one or more raw device tokens. */
export async function sendNotification(deviceTokens: string | string[], alert: ApnAlert, environment: ApnEnvironment = defaultEnvironment()): Promise<void> {
    const tokens = Array.isArray(deviceTokens) ? deviceTokens : [deviceTokens];
    await send(tokens.map((token) => ({ token, environment })), () => alertNotification(alert), "alert");
}

/** Sends an alert to every `alert` device of `userIds` that hasn't filtered `event` out. */
export async function sendNotificationToUsers(userIds: string[], event: NotificationEvent, alert: ApnAlert): Promise<void> {
    if (!apnEnabled()) return;
    const targets = await deviceTargets(userIds, "alert", event);
    await send(targets, () => alertNotification(alert), `alert ${event}`);
}

// ---------------------------------------------------------------------------------------------------------
// diagnostics: `bun run apn:test` (scripts/apn-test.ts)
// ---------------------------------------------------------------------------------------------------------

export interface ApnTestResult {
    token: string,
    environment: ApnEnvironment,
    /** Apple accepted the push for delivery. That is not the same as it being shown on the device. */
    accepted: boolean,
    status: number | null,
    reason: string | null,
    hint: string | null
}

// Apple's rejection reasons, with what usually causes each one in a Nafyn setup
const FAILURE_HINTS: Record<string, string> = {
    BadDeviceToken: "The token is malformed, or belongs to the other APNs environment (Xcode debug builds are sandbox, TestFlight/App Store are production), or to another app.",
    DeviceTokenNotForTopic: "The token was issued to an app with a different bundle ID than APN_BUNDLE_ID.",
    TopicDisallowed: "This key may not push for APN_BUNDLE_ID. Check the bundle ID, and that the key has the APNs service enabled.",
    BadTopic: "APN_BUNDLE_ID is not a valid topic.",
    MissingTopic: "APN_BUNDLE_ID is empty.",
    InvalidProviderToken: "Apple rejected the signing key: APN_KEY_ID and APN_TEAM_ID don't match the .p8 file.",
    MissingProviderToken: "No signing token was sent - the .p8 key could not be read.",
    ExpiredProviderToken: "The signing token expired. Check this machine's clock.",
    Forbidden: "The key is not authorised for this app. Check APN_TEAM_ID and that the key belongs to that team.",
    Unregistered: "The app was uninstalled, or the token is no longer valid. The app has to register a new one.",
    ExpiredToken: "The token expired. The app has to register a new one.",
    TooManyProviderTokenUpdates: "Too many signing tokens were minted in a short time. Wait a few minutes.",
    PayloadTooLarge: "The payload is over Apple's size limit.",
    InternalServerError: "Apple-side error, try again.",
    ServiceUnavailable: "Apple-side error, try again."
};

/**
 * Sends one plain alert to one token and reports exactly what Apple answered.
 *
 * Deliberately NOT sendNotification(): that path deletes a token from apn_devices on BadDeviceToken, and the
 * commonest cause of that answer when testing is asking the wrong environment - which would wipe a perfectly
 * good registration. A diagnostic must never change state.
 */
export async function sendTestAlert(token: string, environment: ApnEnvironment, message: string = "APNs is working"): Promise<ApnTestResult> {
    const base = { token, environment, accepted: false, status: null, reason: null, hint: null };
    if (!apnEnabled()) {
        return { ...base, reason: "NotConfigured", hint: "APN_KEY_ID, APN_TEAM_ID or the .p8 key is missing. Run `bun run check:env`." };
    }

    const notif = baseNotification("alert", null);
    notif.sound = "default";
    notif.aps.alert = { title: "Nafyn", body: message };
    notif.payload = { nafyn: { event: "test" } };

    try {
        const result = await getProvider(environment).send(notif, [token]);
        const failure = result.failed[0];
        if (!failure) return { ...base, accepted: true };

        const reason = failure.response?.reason ?? failure.error?.message ?? null;
        return { ...base, status: failure.status ?? null, reason, hint: reason ? FAILURE_HINTS[reason] ?? null : null };
    } catch (err) {
        return {
            ...base,
            reason: err instanceof Error ? err.message : "Unknown error",
            hint: "Could not complete the request. Check the .p8 key is readable, and that this machine can reach api.push.apple.com and api.sandbox.push.apple.com on port 443."
        };
    }
}

/** the `alert` tokens a user registered through the iOS app, with the environment each one belongs to */
export async function listAlertTargetsForUsername(username: string): Promise<{ token: string, environment: ApnEnvironment, deviceName: string | null }[] | null> {
    const db = getUsersDb();
    const user = await db.prepare(`SELECT id FROM users WHERE username = ?`).get(username) as { id: string } | undefined;
    if (!user) return null;
    return await db.prepare(
        `SELECT token, environment, deviceName FROM apn_devices WHERE userId = ? AND kind = 'alert' ORDER BY lastSeenAt DESC`
    ).all(user.id) as { token: string, environment: ApnEnvironment, deviceName: string | null }[];
}

/** closes the HTTP/2 connections so a one-shot script can exit */
export async function shutdownApn(): Promise<void> {
    await Promise.allSettled([...providers.values()].map((provider) => provider.shutdown()));
    providers.clear();
}

// ---------------------------------------------------------------------------------------------------------
// Live Activities
// ---------------------------------------------------------------------------------------------------------

/** static attributes of a request's Live Activity (NafynRequestActivityAttributes) */
export interface RequestActivityAttributes {
    requestId: string,
    type: "album" | "track",
    title: string,
    artistName: string,
    coverArt: string | null
}

/** NafynRequestActivityAttributes.ContentState */
export interface RequestActivityState {
    stage: "waiting" | "searching" | "downloading" | "processing" | "completed" | "failed",
    message: string | null,
    trackTitle: string | null,
    trackIndex: number | null,
    trackCount: number | null,
    /** 0...1 for the current track's download, null when unknown */
    progress: number | null,
    etaSeconds: number | null
}

/** static attributes of a release countdown (NafynReleaseCountdownAttributes) */
export interface ReleaseActivityAttributes {
    subscriptionId: string,
    musicbrainzId: string,
    type: "album" | "track",
    title: string,
    artistName: string,
    coverArt: string | null
}

/**
 * NafynReleaseCountdownAttributes.ContentState. `releaseAt` is UNIX seconds - declare it as a TimeInterval on
 * the Swift side and convert with Date(timeIntervalSince1970:): ActivityKit decodes content-state with a
 * default JSONDecoder, whose Date strategy counts from 2001, not 1970.
 */
export interface ReleaseActivityState {
    releaseAt: number,
    released: boolean
}

interface LiveActivityOptions {
    event: "start" | "update" | "end",
    contentState: object,
    attributesType?: string,
    attributes?: object,
    alert?: { title: string, body: string },
    staleDateMs?: number,
    dismissalDateMs?: number,
    priority?: number
}

function liveActivityNotification(options: LiveActivityOptions): Notification {
    const notif = baseNotification("liveactivity", ".push-type.liveactivity", options.priority ?? 10);
    notif.aps.timestamp = unixSeconds();
    notif.aps.event = options.event;
    notif.aps["content-state"] = options.contentState;
    if (options.attributesType) notif.aps["attributes-type"] = options.attributesType;
    if (options.attributes) notif.aps.attributes = options.attributes;
    // a push-to-start must carry an alert; elsewhere it lights the screen up for important transitions only
    if (options.alert) notif.aps.alert = options.alert;
    if (options.staleDateMs) notif.aps["stale-date"] = unixSeconds(options.staleDateMs);
    if (options.dismissalDateMs) notif.aps["dismissal-date"] = unixSeconds(options.dismissalDateMs);
    return notif;
}

// last update sent per request, to keep within Apple's Live Activity update budget
const requestActivityThrottle = new Map<string, { sentAt: number, stage: string, trackIndex: number | null }>();

/** Starts a request's progress Live Activity on the requester's devices (push-to-start). */
export async function startRequestActivity(requesterId: string, attributes: RequestActivityAttributes): Promise<void> {
    if (!apnEnabled()) return;
    const targets = await deviceTargets([requesterId], "la-start:request");
    const state: RequestActivityState = {
        stage: "searching", message: null, trackTitle: null, trackIndex: null, trackCount: null, progress: null, etaSeconds: null
    };
    requestActivityThrottle.set(attributes.requestId, { sentAt: Date.now(), stage: state.stage, trackIndex: null });
    await send(targets, () => liveActivityNotification({
        event: "start",
        attributesType: REQUEST_ACTIVITY_TYPE,
        attributes,
        contentState: state,
        alert: { title: attributes.title, body: "Your request was accepted" }
    }), "request activity start");
}

/** Pushes download progress to a running request Live Activity, throttled. Terminal stages go through endRequestActivity. */
export async function updateRequestActivity(event: DownloadProgressEvent): Promise<void> {
    if (!apnEnabled()) return;
    // per-track "completed"/"failed" events arrive in the middle of an album; only the request-level end
    // (endRequestActivity, called once the whole pipeline is done) may end the activity
    if ((event.stage === "completed" || event.stage === "failed") && event.trackIndex === undefined) return;

    const last = requestActivityThrottle.get(event.requestId);
    const now = Date.now();
    const trackIndex = event.trackIndex ?? null;
    const important = !last || last.stage !== event.stage || last.trackIndex !== trackIndex;
    if (!important && now - last.sentAt < REQUEST_UPDATE_MIN_INTERVAL_MS) return;

    const targets = await activityTargets("request", event.requestId);
    if (targets.length === 0) return;
    requestActivityThrottle.set(event.requestId, { sentAt: now, stage: event.stage, trackIndex });

    // a per-track "completed" between album tracks reads as "processing" from the outside: the request isn't done
    const stage: RequestActivityState["stage"] = event.stage === "completed" || event.stage === "failed" ? "processing" : event.stage;
    const state: RequestActivityState = {
        stage,
        message: event.message ?? null,
        trackTitle: event.trackTitle ?? null,
        trackIndex,
        trackCount: event.trackCount ?? null,
        progress: event.totalBytes ? Math.min(1, (event.bytesDownloaded ?? 0) / event.totalBytes) : null,
        etaSeconds: event.etaSeconds ?? null
    };
    await send(targets, () => liveActivityNotification({
        event: "update",
        contentState: state,
        priority: important ? 10 : 5
    }), "request activity update");
}

/** Ends a request's Live Activity; it stays visible for 25 minutes with the final outcome. */
export async function endRequestActivity(requestId: string, outcome: "completed" | "failed", message: string | null = null): Promise<void> {
    requestActivityThrottle.delete(requestId);
    if (!apnEnabled()) return;
    const targets = await activityTargets("request", requestId);
    if (targets.length === 0) return;
    const state: RequestActivityState = {
        stage: outcome, message, trackTitle: null, trackIndex: null, trackCount: null, progress: outcome === "completed" ? 1 : null, etaSeconds: null
    };
    await send(targets, () => liveActivityNotification({
        event: "end",
        contentState: state,
        dismissalDateMs: Date.now() + REQUEST_ACTIVITY_LINGER_MS
    }), "request activity end");
    await deleteActivityTokens("request", requestId);
}

/** Starts the release countdown Live Activity on the subscriber's devices (push-to-start). */
export async function startReleaseActivity(userId: string, attributes: ReleaseActivityAttributes, releaseAtMs: number): Promise<void> {
    if (!apnEnabled()) return;
    const targets = await deviceTargets([userId], "la-start:release");
    const state: ReleaseActivityState = { releaseAt: unixSeconds(releaseAtMs), released: false };
    await send(targets, () => liveActivityNotification({
        event: "start",
        attributesType: RELEASE_ACTIVITY_TYPE,
        attributes,
        contentState: state,
        staleDateMs: releaseAtMs,
        alert: { title: attributes.title, body: `${attributes.artistName} - out in less than 3 hours` }
    }), "release activity start");
}

/** At release: flips the countdown to "out now" and lets it linger for an hour. */
export async function endReleaseActivity(subscriptionId: string, releaseAtMs: number): Promise<void> {
    if (!apnEnabled()) return;
    const targets = await activityTargets("release", subscriptionId);
    if (targets.length === 0) return;
    const state: ReleaseActivityState = { releaseAt: unixSeconds(releaseAtMs), released: true };
    await send(targets, () => liveActivityNotification({
        event: "end",
        contentState: state,
        dismissalDateMs: Math.max(Date.now(), releaseAtMs) + RELEASE_ACTIVITY_LINGER_MS
    }), "release activity end");
    await deleteActivityTokens("release", subscriptionId);
}

// ---------------------------------------------------------------------------------------------------------
// Now Playing remote sessions (iOS 27, NowPlaying framework)
// ---------------------------------------------------------------------------------------------------------
//
// When a Nafyn Unity master is playing somewhere else (a browser tab, say), every other Apple device on the
// account is a potential Unity slave - it gets a remote media session in its system Now Playing UI, driven
// from here: `start` to the device's push-to-start token, then `update`/`end` to the per-session token the app
// sends back (POST /api/v1/user/activities, kind "nowplaying", refId = the session id from `attributes.id`).
// The device that *is* the master plays locally and never gets one.
//
// Unity's master broadcasts its full player state about once a second. That cadence is for open sockets; push
// budgets are far tighter, so only a meaningful change (track, play/pause, queue length, volume, or a seek that
// doesn't match where the clock says playback should be) becomes a push. Like the Unity registry itself this is
// per-process memory, which matches Unity's own single-instance constraint.

/** the slice of a Unity master's PlayerState (app/composables/usePlayer.ts) that remote sessions use */
export interface UnityPlayerState {
    queue?: { id?: string, title?: string, artistName?: string, album?: string | null, coverArt?: string | null, duration?: number }[],
    currentIndex?: number,
    isPlaying?: boolean,
    currentTime?: number,
    duration?: number,
    volume?: number,
    muted?: boolean
}

/** payload `aps.attributes` - matches Apple's "Publishing remote media sessions" sample, decoded by the app */
export interface NowPlayingAttributes {
    id: string,
    devices?: { id: string, name: string, type: "computer" | "phone" | "tablet" | "speaker", volume: number }[],
    isPlaying?: boolean,
    currentTrackIndex?: number,
    queueCount?: number,
    elapsedTime?: number,
    /** ISO 8601 instant `elapsedTime` was sampled at */
    timestamp?: string,
    currentTrack?: {
        id: string,
        title: string,
        artist: string,
        album: string | null,
        duration: number,
        artworkURL: string | null
    }
}

interface NowPlayingSession {
    id: string,
    masterSessionId: string,
    masterLabel: string,
    startedSessions: Set<string>,
    last: { trackId: string | null, isPlaying: boolean, queueCount: number, volume: number, elapsed: number, at: number } | null,
    unityEnabled: { value: boolean, checkedAt: number } | null
}

const nowPlaying = new Map<string, NowPlayingSession>();
const SEEK_TOLERANCE_S = 3;
const UNITY_SETTING_TTL_MS = 60_000;

function deviceType(label: string): "computer" | "phone" | "tablet" | "speaker" {
    if (/iPad|Tablet/i.test(label)) return "tablet";
    if (/iPhone|Android|iOS|Mobile/i.test(label)) return "phone";
    return "computer";
}

function buildAttributes(session: NowPlayingSession, state: UnityPlayerState): NowPlayingAttributes {
    const queue = state.queue ?? [];
    const index = state.currentIndex ?? 0;
    const track = queue[index];
    const volume = state.muted ? 0 : Math.max(0, Math.min(1, state.volume ?? 1));
    return {
        id: session.id,
        // the master's jti is a revocation handle, not something to hand to other devices verbatim
        devices: [{ id: `unity-${session.id.slice(0, 8)}`, name: session.masterLabel, type: deviceType(session.masterLabel), volume }],
        isPlaying: !!state.isPlaying,
        currentTrackIndex: index,
        queueCount: queue.length,
        elapsedTime: Math.max(0, state.currentTime ?? 0),
        timestamp: new Date().toISOString(),
        currentTrack: track ? {
            id: track.id ?? "",
            title: track.title ?? "",
            artist: track.artistName ?? "",
            album: track.album ?? null,
            duration: track.duration ?? state.duration ?? 0,
            // only an absolute, publicly fetchable cover - a custom upload sits behind Nafyn's auth
            artworkURL: track.coverArt && /^https:\/\//.test(track.coverArt) ? track.coverArt : null
        } : undefined
    };
}

function nowPlayingNotification(event: "start" | "update" | "end", attributes: NowPlayingAttributes): Notification {
    const notif = baseNotification("nowplaying", ".push-type.nowplaying", 10);
    notif.aps.event = event;
    notif.aps.timestamp = unixSeconds();
    notif.aps.attributes = attributes;
    return notif;
}

async function unityEnabledFor(userId: string, session: NowPlayingSession): Promise<boolean> {
    if (process.env.NAFYN_UNITY_ENABLED === "false") return false;
    const cached = session.unityEnabled;
    if (cached && Date.now() - cached.checkedAt < UNITY_SETTING_TTL_MS) return cached.value;
    const value = (await getUnitySettings(userId).catch(() => ({ enabled: true }))).enabled;
    session.unityEnabled = { value, checkedAt: Date.now() };
    return value;
}

// per-user serial queue: state arrives every second and handling one can await the database, so two
// overlapping calls could otherwise both decide to `start` the same device
const queues = new Map<string, Promise<void>>();

function enqueue(userId: string, work: () => Promise<void>): Promise<void> {
    const next = (queues.get(userId) ?? Promise.resolve())
        .then(work)
        .catch((err) => console.error("[apn] now playing:", err))
        .finally(() => {
            if (queues.get(userId) === next) queues.delete(userId);
        });
    queues.set(userId, next);
    return next;
}

/**
 * Called with every state the Unity master broadcasts (server/utils/unityRegistry.ts). Cheap on the hot path:
 * nothing touches the database unless the state changed in a way a remote session would show.
 */
export function nowPlayingOnState(userId: string, masterSessionId: string, masterLabel: string, rawState: unknown): Promise<void> {
    if (!apnEnabled() || !rawState || typeof rawState !== "object") return Promise.resolve();
    return enqueue(userId, () => handleState(userId, masterSessionId, masterLabel, rawState as UnityPlayerState));
}

async function handleState(userId: string, masterSessionId: string, masterLabel: string, state: UnityPlayerState): Promise<void> {

    let session = nowPlaying.get(userId);
    if (session && session.masterSessionId !== masterSessionId) {
        await endSession(userId);
        session = undefined;
    }

    const track = state.queue?.[state.currentIndex ?? 0];
    if (!session) {
        if (!track) return; // nothing loaded, nothing to show
        session = { id: randomUUID(), masterSessionId, masterLabel, startedSessions: new Set(), last: null, unityEnabled: null };
        nowPlaying.set(userId, session);
    }

    const now = Date.now();
    const elapsed = state.currentTime ?? 0;
    const next = {
        trackId: track?.id ?? null,
        isPlaying: !!state.isPlaying,
        queueCount: state.queue?.length ?? 0,
        volume: state.muted ? 0 : Math.round((state.volume ?? 1) * 100) / 100,
        elapsed,
        at: now
    };

    const last = session.last;
    const expectedElapsed = last ? last.elapsed + (last.isPlaying ? (now - last.at) / 1000 : 0) : 0;
    const changed = !last
        || last.trackId !== next.trackId
        || last.isPlaying !== next.isPlaying
        || last.queueCount !== next.queueCount
        || last.volume !== next.volume
        || Math.abs(expectedElapsed - elapsed) > SEEK_TOLERANCE_S;

    if (!changed) {
        // keep the extrapolation anchor fresh, so a long track doesn't slowly drift into a false "seek"
        session.last = next;
        return;
    }
    session.last = next;

    if (!await unityEnabledFor(userId, session)) return;
    const attributes = buildAttributes(session, state);

    // devices that haven't been started yet (first change, or registered since) get a `start`...
    const startTargets = (await deviceTargets([userId], "nowplaying-start", undefined, masterSessionId))
        .filter((t) => !session.startedSessions.has(t.sessionId));
    if (startTargets.length > 0) {
        for (const t of startTargets) session.startedSessions.add(t.sessionId);
        await send(startTargets, () => nowPlayingNotification("start", attributes), "now playing start");
    }

    // ...and every session that already reported its update token gets the `update`
    const updateTargets = await activityTargets("nowplaying", session.id);
    await send(updateTargets, () => nowPlayingNotification("update", attributes), "now playing update");
}

/** Ends the user's remote session everywhere (master gone, master changed, account erased). */
export function nowPlayingEnd(userId: string): Promise<void> {
    if (!nowPlaying.has(userId)) return Promise.resolve();
    return enqueue(userId, () => endSession(userId));
}

async function endSession(userId: string): Promise<void> {
    const session = nowPlaying.get(userId);
    if (!session) return;
    nowPlaying.delete(userId);
    if (!apnEnabled()) return;

    const targets = await activityTargets("nowplaying", session.id);
    await send(targets, () => nowPlayingNotification("end", { id: session.id }), "now playing end");
    await deleteActivityTokens("nowplaying", session.id);
}

/** the user's current remote session id, so POST /api/v1/user/activities can check a `nowplaying` refId */
export function currentNowPlayingSessionId(userId: string): string | null {
    return nowPlaying.get(userId)?.id ?? null;
}
