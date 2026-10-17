// outbound webhooks: storage, URL safety, per-service formatting and delivery.
//
// Two scopes share one table (`webhooks`, migrations.ts):
//   * local  - userId set: one user's own webhooks, editable by that user whatever their permissions, receiving
//              only notifications aimed at that user (server/core/notifications.ts decides who that is);
//   * global - userId NULL: the instance's own, editable under MANAGE_WEBHOOKS, receiving every request event.
//
// SECURITY: any account can make this server POST to a URL of its choosing, which is a textbook SSRF primitive.
// Three layers keep it pointed at the internet rather than at the LAN / cloud metadata / localhost admin ports:
//   1. https only (plain http only for global webhooks, and only with NAFYN_WEBHOOK_ALLOW_PRIVATE=true);
//   2. the hostname is resolved and every address checked against private/reserved ranges at save time;
//   3. at send time the host is resolved again, checked again, and the request connects to that exact address
//      (pinAddress) - so a DNS-rebinding record can't swap in 127.0.0.1 between the check and the connect.
//      Redirects are never followed (node's http client doesn't), so a public URL can't 302 the request
//      somewhere internal either.
// Private targets (a LAN Home Assistant, a self-hosted ntfy) are possible for global webhooks only, behind the
// env flag, because only an operator-level account should be able to aim the server at its own network.
//
// The URL itself is a credential (a Discord/Slack webhook URL is all it takes to post into that channel), so
// it never leaves the server again after creation: listings carry `urlPreview` (scheme + host), and the GDPR
// export only names the host.
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { H3Event } from "h3";
import { getUsersDb } from "../core/db";
import { getPermissionsById } from "../core/users";
import { hasPermission, Permission } from "../entity/Permission";
import { requireAuthToken } from "./requireAuth";
import {
    GLOBAL_WEBHOOK_EVENTS,
    isNotificationEvent,
    WEBHOOK_FORMATS,
    type NotificationEvent,
    type NotificationMessage,
    type WebhookFormat,
    type WebhookSummary
} from "../entity/Notification";
import { publicBaseUrl } from "./publicUrl";

const MAX_USER_WEBHOOKS = 10;
const MAX_GLOBAL_WEBHOOKS = 20;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 100;
const DELIVERY_TIMEOUT_MS = 8_000;
// consecutive failures before a webhook is switched off; the settings UI shows why
const AUTO_DISABLE_AFTER = 10;
const USER_AGENT = "Nafyn (+https://github.com/lumaa-dev/Nafyn)";

interface WebhookRow {
    id: string,
    userId: string | null,
    name: string,
    url: string,
    format: WebhookFormat,
    events: string | null,
    enabled: number,
    failureCount: number,
    lastError: string | null,
    lastDeliveredAt: number | null,
    createdAt: number
}

export class WebhookError extends Error {
    constructor(message: string, public statusCode: number = 400) {
        super(message);
    }
}

// ---------------------------------------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------------------------------------

// Explicit CIDR arithmetic rather than net.BlockList: BlockList's behaviour differs between runtimes (under
// bun it matched nothing at all), and this check is the whole SSRF defence, so it must not depend on that.
const V4_BLOCKED: [string, number][] = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
];
const V6_BLOCKED: [string, number][] = [
    ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96], ["100::", 64]
];

function ipv4ToBigInt(address: string): bigint {
    return address.split(".").reduce((acc, part) => (acc << BigInt(8)) | BigInt(Number(part) & 0xff), BigInt(0));
}

function ipv6ToBigInt(address: string): bigint {
    let text = address;
    // an embedded dotted IPv4 tail (::ffff:10.0.0.1) becomes two hex groups
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (dotted?.[1]) {
        const v4 = ipv4ToBigInt(dotted[1]);
        text = text.slice(0, -dotted[1].length) + `${(v4 >> BigInt(16)).toString(16)}:${(v4 & BigInt(0xffff)).toString(16)}`;
    }
    const [head = "", tail] = text.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const groups = tail === undefined
        ? headGroups
        : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups];
    return groups.reduce((acc, group) => (acc << BigInt(16)) | BigInt(parseInt(group || "0", 16)), BigInt(0));
}

function inBlocks(value: bigint, bits: number, blocks: [string, number][], parse: (a: string) => bigint): boolean {
    return blocks.some(([net, prefix]) => {
        const shift = BigInt(bits - prefix);
        return (value >> shift) === (parse(net) >> shift);
    });
}

function isPrivateAddress(raw: string): boolean {
    const address = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // brackets, IPv6 zone id
    const family = isIP(address);
    if (family === 4) return inBlocks(ipv4ToBigInt(address), 32, V4_BLOCKED, ipv4ToBigInt);
    if (family === 6) {
        const value = ipv6ToBigInt(address);
        // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d) forms are IPv4
        // addresses wearing a costume - URL parsing even rewrites them to hex (::ffff:7f00:1)
        const high = value >> BigInt(32);
        if (high === BigInt(0xffff) || (high === BigInt(0) && value > BigInt(1))) {
            return inBlocks(value & BigInt(0xffffffff), 32, V4_BLOCKED, ipv4ToBigInt);
        }
        return inBlocks(value, 128, V6_BLOCKED, ipv6ToBigInt);
    }
    return true; // not an IP at all: refuse rather than guess
}

function allowPrivateTargets(global: boolean): boolean {
    return global && process.env.NAFYN_WEBHOOK_ALLOW_PRIVATE === "true";
}

function resolveAll(hostname: string): Promise<LookupAddress[]> {
    return new Promise((resolve, reject) => {
        dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => err ? reject(err) : resolve(addresses));
    });
}

/**
 * Resolves the host a webhook is about to be sent to and returns the one address to connect to, refusing a
 * private one. The caller connects to *this address* (not the hostname), so what was checked is what gets
 * connected to - a DNS-rebinding record can't hand out a public address here and 127.0.0.1 a moment later.
 * (A `lookup` hook on the request would not do: Node skips it for IP-literal hosts and bun ignores it.)
 */
async function pinAddress(hostname: string, allowPrivate: boolean): Promise<{ address: string, family: number }> {
    const host = hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveAll(host);
    if (addresses.length === 0) throw new Error(`No address for ${host}`);
    if (!allowPrivate) {
        const bad = addresses.find((a) => isPrivateAddress(a.address));
        if (bad) throw new Error(`Refusing to connect to private address ${bad.address}`);
    }
    return addresses[0]!;
}

/** Parses and vets a webhook URL. Throws WebhookError with a user-facing message when it isn't acceptable. */
export async function assertSafeWebhookUrl(raw: unknown, global: boolean): Promise<URL> {
    if (typeof raw !== "string" || raw.trim().length === 0) throw new WebhookError("A webhook URL is required");
    if (raw.length > MAX_URL_LENGTH) throw new WebhookError("Webhook URL is too long");

    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new WebhookError("Invalid webhook URL");
    }

    const allowPrivate = allowPrivateTargets(global);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivate)) {
        throw new WebhookError("Webhook URLs must use https");
    }
    if (url.port && !allowPrivate && url.port !== "443") {
        throw new WebhookError("Webhook URLs must use the default https port");
    }

    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate) {
        if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
            throw new WebhookError("Webhook URL points to a private address");
        }
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolveAll(host).catch(() => {
            throw new WebhookError("Webhook host could not be resolved");
        });
        if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
            throw new WebhookError("Webhook URL points to a private address");
        }
    }

    return url;
}

/** `https://discord.com/…` - enough to recognise a webhook in a list without handing its secret back out */
export function maskWebhookUrl(raw: string): string {
    try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}/…`;
    } catch {
        return "…";
    }
}

/** best guess at which service a URL belongs to; the user can always override it */
export function detectWebhookFormat(url: URL): WebhookFormat {
    const host = url.hostname.toLowerCase();
    if ((host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com") || host.endsWith(".discordapp.com"))
        && url.pathname.startsWith("/api/webhooks/")) return "discord";
    if (host === "hooks.slack.com") return "slack";
    if (host === "ntfy.sh" || host.startsWith("ntfy.") || url.pathname.startsWith("/ntfy/")) return "ntfy";
    if (url.pathname.replace(/\/+$/, "").endsWith("/message") && url.searchParams.has("token")) return "gotify";
    return "json";
}

// ---------------------------------------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------------------------------------

function parseEvents(raw: string | null): NotificationEvent[] | null {
    if (raw == null) return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isNotificationEvent) : null;
    } catch {
        return null;
    }
}

function rowToSummary(row: WebhookRow): WebhookSummary {
    return {
        id: row.id,
        global: row.userId === null,
        name: row.name,
        format: row.format,
        urlPreview: maskWebhookUrl(row.url),
        events: parseEvents(row.events),
        enabled: !!row.enabled,
        failureCount: Number(row.failureCount),
        lastError: row.lastError,
        lastDeliveredAt: row.lastDeliveredAt == null ? null : Number(row.lastDeliveredAt),
        createdAt: Number(row.createdAt)
    };
}

function validateName(raw: unknown): string {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) throw new WebhookError("A name is required");
    if (name.length > MAX_NAME_LENGTH) throw new WebhookError(`Name must be at most ${MAX_NAME_LENGTH} characters`);
    return name;
}

function validateFormat(raw: unknown): WebhookFormat | null {
    if (raw == null || raw === "auto") return null;
    if (typeof raw !== "string" || !(WEBHOOK_FORMATS as readonly string[]).includes(raw)) throw new WebhookError("Unknown webhook format");
    return raw as WebhookFormat;
}

// null = everything; an explicit list is narrowed to the events this scope can receive at all
function validateEvents(raw: unknown, global: boolean): NotificationEvent[] | null {
    if (raw == null) return null;
    if (!Array.isArray(raw) || !raw.every(isNotificationEvent)) throw new WebhookError("Unknown notification event");
    const allowed = global ? raw.filter((e) => GLOBAL_WEBHOOK_EVENTS.includes(e)) : raw;
    return [...new Set(allowed)];
}

// `userId` null addresses global webhooks only: the `<=>` NULL-safe comparison can never let a user-scoped call
// match a global row or vice versa
async function getRow(userId: string | null, id: string): Promise<WebhookRow | undefined> {
    return await getUsersDb().prepare(`SELECT * FROM webhooks WHERE id = ? AND userId <=> ?`).get(id, userId) as WebhookRow | undefined;
}

export async function listUserWebhooks(userId: string): Promise<WebhookSummary[]> {
    const rows = await getUsersDb().prepare(`SELECT * FROM webhooks WHERE userId = ? ORDER BY createdAt ASC`).all(userId) as WebhookRow[];
    return rows.map(rowToSummary);
}

export async function listGlobalWebhooks(): Promise<WebhookSummary[]> {
    const rows = await getUsersDb().prepare(`SELECT * FROM webhooks WHERE userId IS NULL ORDER BY createdAt ASC`).all() as WebhookRow[];
    return rows.map(rowToSummary);
}

export interface WebhookInput {
    name?: unknown,
    url?: unknown,
    format?: unknown,
    events?: unknown,
    enabled?: unknown
}

/** `userId` null creates a global webhook - the caller must already have checked MANAGE_WEBHOOKS */
export async function createWebhook(userId: string | null, input: WebhookInput): Promise<WebhookSummary> {
    const global = userId === null;
    const name = validateName(input.name);
    const url = await assertSafeWebhookUrl(input.url, global);
    const format = validateFormat(input.format) ?? detectWebhookFormat(url);
    const events = validateEvents(input.events, global);

    const countRow = await getUsersDb().prepare(`SELECT COUNT(*) AS count FROM webhooks WHERE userId <=> ?`).get(userId) as { count: number };
    const limit = global ? MAX_GLOBAL_WEBHOOKS : MAX_USER_WEBHOOKS;
    if (Number(countRow.count) >= limit) throw new WebhookError(`At most ${limit} webhooks`, 409);

    const row: WebhookRow = {
        id: randomUUID(),
        userId,
        name,
        url: url.toString(),
        format,
        events: events ? JSON.stringify(events) : null,
        enabled: 1,
        failureCount: 0,
        lastError: null,
        lastDeliveredAt: null,
        createdAt: Date.now()
    };

    await getUsersDb().prepare(`
        INSERT INTO webhooks (id, userId, name, url, format, events, enabled, failureCount, lastError, lastDeliveredAt, createdAt)
        VALUES (:id, :userId, :name, :url, :format, :events, :enabled, :failureCount, :lastError, :lastDeliveredAt, :createdAt)
    `).run(row);

    return rowToSummary(row);
}

/** partial update; re-enabling a webhook clears its failure streak */
export async function updateWebhook(userId: string | null, id: string, input: WebhookInput): Promise<WebhookSummary | null> {
    const existing = await getRow(userId, id);
    if (!existing) return null;
    const global = userId === null;

    const next: WebhookRow = { ...existing };
    if (input.name !== undefined) next.name = validateName(input.name);
    if (input.url !== undefined) {
        const url = await assertSafeWebhookUrl(input.url, global);
        next.url = url.toString();
        if (input.format === undefined) next.format = detectWebhookFormat(url);
    }
    if (input.format !== undefined) next.format = validateFormat(input.format) ?? detectWebhookFormat(new URL(next.url));
    if (input.events !== undefined) {
        const events = validateEvents(input.events, global);
        next.events = events ? JSON.stringify(events) : null;
    }
    if (input.enabled !== undefined) {
        if (typeof input.enabled !== "boolean") throw new WebhookError("enabled must be a boolean");
        next.enabled = input.enabled ? 1 : 0;
        if (input.enabled && !existing.enabled) {
            next.failureCount = 0;
            next.lastError = null;
        }
    }

    await getUsersDb().prepare(`
        UPDATE webhooks SET name = :name, url = :url, format = :format, events = :events, enabled = :enabled,
            failureCount = :failureCount, lastError = :lastError
        WHERE id = :id AND userId <=> :userId
    `).run({
        id, userId,
        name: next.name, url: next.url, format: next.format, events: next.events, enabled: next.enabled,
        failureCount: next.failureCount, lastError: next.lastError
    });

    return rowToSummary(next);
}

export async function deleteWebhook(userId: string | null, id: string): Promise<boolean> {
    const result = await getUsersDb().prepare(`DELETE FROM webhooks WHERE id = ? AND userId <=> ?`).run(id, userId);
    return result.changes > 0;
}

// erasure helper (GDPR art. 17)
export async function deleteWebhooksForUser(userId: string): Promise<number> {
    const result = await getUsersDb().prepare(`DELETE FROM webhooks WHERE userId = ?`).run(userId);
    return result.changes;
}

// data-access export (GDPR art. 15): what exists and where it points, never the URL itself (a secret)
export async function listWebhookExportForUser(userId: string): Promise<{ name: string, format: string, host: string | null, events: NotificationEvent[] | null, enabled: boolean, createdAt: number }[]> {
    const rows = await getUsersDb().prepare(`SELECT * FROM webhooks WHERE userId = ? ORDER BY createdAt ASC`).all(userId) as WebhookRow[];
    return rows.map((row) => {
        let host: string | null = null;
        try { host = new URL(row.url).host; } catch { /* stays null */ }
        return { name: row.name, format: row.format, host, events: parseEvents(row.events), enabled: !!row.enabled, createdAt: Number(row.createdAt) };
    });
}

// ---------------------------------------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------------------------------------

const EVENT_COLORS: Record<NotificationMessage["event"], number> = {
    "request.created": 0x5865f2,
    "request.accepted": 0x57f287,
    "request.denied": 0xed4245,
    "request.completed": 0x57f287,
    "request.failed": 0xed4245,
    "release.out": 0xfee75c,
    "test": 0x5865f2
};

const NTFY_TAGS: Record<NotificationMessage["event"], string[]> = {
    "request.created": ["inbox_tray"],
    "request.accepted": ["white_check_mark"],
    "request.denied": ["no_entry"],
    "request.completed": ["musical_note", "tada"],
    "request.failed": ["x"],
    "release.out": ["calendar", "musical_note"],
    "test": ["bell"]
};

interface OutgoingRequest {
    url: URL,
    headers: Record<string, string>,
    body: string
}

function discordEscape(text: string): string {
    return text.replace(/([\\*_`~|>#[\]()-])/g, "\\$1");
}

function slackEscape(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Discord Components V2 (flag IS_COMPONENTS_V2 = 1 << 15). With the flag set a message may only carry
// `components` - `content`/`embeds` are a 400 - and a webhook nobody's application owns only honours them
// with `?with_components=true`, and only non-interactive ones (link buttons are fine, they never call back).
function formatDiscord(url: URL, message: NotificationMessage): OutgoingRequest {
    const target = new URL(url.toString());
    target.searchParams.set("with_components", "true");

    const texts: Record<string, unknown>[] = [
        { type: 10, content: `## ${discordEscape(message.title)}` },
        { type: 10, content: discordEscape(message.body) }
    ];
    if (message.footer) texts.push({ type: 10, content: `-# ${discordEscape(message.footer)}` });

    const inner: Record<string, unknown>[] = message.imageUrl
        // a Section must have an accessory, so it is only used when there is a cover to put there
        ? [{ type: 9, components: texts, accessory: { type: 11, media: { url: message.imageUrl } } }]
        : texts;

    if (message.url) {
        inner.push({ type: 14, divider: true, spacing: 1 });
        inner.push({ type: 1, components: [{ type: 2, style: 5, label: "Open in Nafyn", url: message.url }] });
    }

    return {
        url: target,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: "Nafyn",
            flags: 1 << 15,
            allowed_mentions: { parse: [] },
            components: [{ type: 17, accent_color: EVENT_COLORS[message.event], components: inner }]
        })
    };
}

function formatSlack(url: URL, message: NotificationMessage): OutgoingRequest {
    const section: Record<string, unknown> = {
        type: "section",
        text: { type: "mrkdwn", text: `*${slackEscape(message.title)}*\n${slackEscape(message.body)}` }
    };
    if (message.imageUrl) section.accessory = { type: "image", image_url: message.imageUrl, alt_text: "Cover art" };

    const blocks: Record<string, unknown>[] = [section];
    if (message.footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: slackEscape(message.footer) }] });
    if (message.url) {
        blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Nafyn" }, url: message.url }] });
    }

    return {
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${message.title}: ${message.body}`, blocks })
    };
}

// ntfy's JSON publishing (POST to the server root with the topic in the body) rather than header-based
// publishing, because HTTP headers can't carry a non-ASCII title without RFC 2047 contortions. The configured
// URL is the topic URL (https://ntfy.sh/mytopic): its last path segment is the topic, the rest is the root -
// which keeps working behind a reverse proxy under a sub-path. Query params (?auth=…) and URL credentials
// (https://user:pass@…) carry over as ntfy's own auth mechanisms.
function formatNtfy(url: URL, message: NotificationMessage): OutgoingRequest {
    const segments = url.pathname.replace(/\/+$/, "").split("/");
    const topic = segments.pop() ?? "";
    const root = new URL(url.toString());
    root.pathname = segments.join("/") || "/";
    root.username = "";
    root.password = "";

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (url.username) {
        headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
    }

    const payload: Record<string, unknown> = {
        topic,
        title: message.title,
        message: message.footer ? `${message.body}\n${message.footer}` : message.body,
        tags: NTFY_TAGS[message.event]
    };
    if (message.url) payload.click = message.url;
    if (message.imageUrl) payload.icon = message.imageUrl;

    return { url: root, headers, body: JSON.stringify(payload) };
}

function formatGotify(url: URL, message: NotificationMessage): OutgoingRequest {
    const notification: Record<string, unknown> = {};
    if (message.url) notification.click = { url: message.url };
    if (message.imageUrl) notification.bigImageUrl = message.imageUrl;

    const extras: Record<string, unknown> = { "client::display": { contentType: "text/plain" } };
    if (Object.keys(notification).length > 0) extras["client::notification"] = notification;

    return {
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title: message.title,
            message: message.footer ? `${message.body}\n${message.footer}` : message.body,
            priority: message.event === "request.failed" || message.event === "request.denied" ? 6 : 5,
            extras
        })
    };
}

function formatJson(url: URL, message: NotificationMessage): OutgoingRequest {
    return {
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            source: "nafyn",
            instance: publicBaseUrl(),
            event: message.event,
            title: message.title,
            body: message.body,
            footer: message.footer ?? null,
            url: message.url ?? null,
            imageUrl: message.imageUrl ?? null,
            data: message.data ?? {},
            timestamp: new Date().toISOString()
        })
    };
}

function formatFor(format: WebhookFormat, url: URL, message: NotificationMessage): OutgoingRequest {
    switch (format) {
        case "discord": return formatDiscord(url, message);
        case "slack": return formatSlack(url, message);
        case "ntfy": return formatNtfy(url, message);
        case "gotify": return formatGotify(url, message);
        default: return formatJson(url, message);
    }
}

// ---------------------------------------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------------------------------------

async function post(out: OutgoingRequest, allowPrivate: boolean): Promise<{ status: number, body: string }> {
    const target = await pinAddress(out.url.hostname, allowPrivate);
    const isHttps = out.url.protocol === "https:";
    const hostname = out.url.hostname.replace(/^\[|\]$/g, "");
    const payload = Buffer.from(out.body);

    const headers: Record<string, string> = {
        ...out.headers,
        Host: out.url.host,
        "User-Agent": USER_AGENT,
        "Content-Length": String(payload.length)
    };
    if (out.url.username && !headers.Authorization) {
        headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(out.url.username)}:${decodeURIComponent(out.url.password)}`).toString("base64")}`;
    }

    return await new Promise((resolve, reject) => {
        const doRequest = isHttps ? httpsRequest : httpRequest;
        const req = doRequest({
            method: "POST",
            // connect to the address that was vetted, while TLS (SNI + certificate check) and the Host header
            // still speak the hostname
            host: target.address,
            family: target.family,
            port: out.url.port || (isHttps ? 443 : 80),
            path: `${out.url.pathname}${out.url.search}`,
            servername: isHttps && !isIP(hostname) ? hostname : undefined,
            timeout: DELIVERY_TIMEOUT_MS,
            headers
        }, (res) => {
            // only the first couple of KB matter (an error message to surface in the settings UI)
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
                if (size < 2048) chunks.push(chunk);
                size += chunk.length;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, 2048) }));
            res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error("Timed out")));
        req.on("error", reject);
        req.end(payload);
    });
}

async function recordResult(id: string, error: string | null): Promise<void> {
    const db = getUsersDb();
    if (error === null) {
        await db.prepare(`UPDATE webhooks SET failureCount = 0, lastError = NULL, lastDeliveredAt = ? WHERE id = ?`).run(Date.now(), id);
        return;
    }
    await db.prepare(`
        UPDATE webhooks SET failureCount = failureCount + 1, lastError = ?,
            enabled = CASE WHEN failureCount + 1 >= ? THEN 0 ELSE enabled END
        WHERE id = ?
    `).run(error.slice(0, 500), AUTO_DISABLE_AFTER, id);
}

async function deliver(row: WebhookRow, message: NotificationMessage): Promise<string | null> {
    let error: string | null = null;
    try {
        const url = new URL(row.url);
        const out = formatFor(row.format, url, message);
        const { status, body } = await post(out, allowPrivateTargets(row.userId === null));
        if (status >= 300 && status < 400) error = `HTTP ${status}: redirects are not followed`;
        else if (status < 200 || status >= 300) error = `HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ""}`;
    } catch (err) {
        error = err instanceof Error ? err.message : "Delivery failed";
    }

    await recordResult(row.id, error).catch((err) => console.error("[webhook] could not record delivery result:", err));
    if (error) console.warn(`[webhook] ${row.format} webhook ${row.id} failed: ${error}`);
    return error;
}

function wants(row: WebhookRow, event: NotificationEvent): boolean {
    const events = parseEvents(row.events);
    return events === null || events.includes(event);
}

async function deliverAll(rows: WebhookRow[], message: NotificationMessage): Promise<void> {
    const event = message.event;
    if (event === "test") return;
    await Promise.allSettled(rows.filter((row) => wants(row, event)).map((row) => deliver(row, message)));
}

/** Local webhooks: every enabled webhook owned by any of `userIds` that subscribes to this event. */
export async function sendWebhookToUsers(userIds: string[], message: NotificationMessage): Promise<void> {
    if (userIds.length === 0) return;
    const placeholders = userIds.map(() => "?").join(", ");
    const rows = await getUsersDb().prepare(
        `SELECT * FROM webhooks WHERE enabled = 1 AND userId IN (${placeholders})`
    ).all(...userIds) as WebhookRow[];
    await deliverAll(rows, message);
}

/** Global webhooks: the instance's own, for notifications that concern everyone. */
export async function sendGlobalWebhook(message: NotificationMessage): Promise<void> {
    if (message.event !== "test" && !GLOBAL_WEBHOOK_EVENTS.includes(message.event)) return;
    const rows = await getUsersDb().prepare(`SELECT * FROM webhooks WHERE enabled = 1 AND userId IS NULL`).all() as WebhookRow[];
    await deliverAll(rows, message);
}

/** Sends a sample message to one webhook regardless of its enabled flag or event filter; returns the error, if any. */
export async function sendTestWebhook(userId: string | null, id: string): Promise<{ found: boolean, error: string | null }> {
    const row = await getRow(userId, id);
    if (!row) return { found: false, error: null };
    const error = await deliver(row, {
        event: "test",
        title: "Nafyn webhook test",
        body: `If you can read this, "${row.name}" is set up correctly.`,
        footer: row.userId === null ? "Instance webhook" : "Personal webhook",
        url: publicBaseUrl(),
        data: { test: true }
    });
    return { found: true, error };
}

// ---------------------------------------------------------------------------------------------------------
// route helpers
// ---------------------------------------------------------------------------------------------------------

/** Rethrows a WebhookError as the matching HTTP error; anything else propagates untouched. */
export function rethrowWebhookError(err: unknown): never {
    if (err instanceof WebhookError) throw createError({ statusCode: err.statusCode, statusMessage: err.message });
    throw err;
}

/** global webhooks are instance configuration: MANAGE_WEBHOOKS (or ADMIN) only */
export async function requireWebhookManager(event: H3Event): Promise<string> {
    const { sub: userId } = await requireAuthToken(event);
    if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.MANAGE_WEBHOOKS)) {
        throw createError({ statusCode: 403, statusMessage: "Unsufficient permissions" });
    }
    return userId;
}
