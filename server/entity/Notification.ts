// notification events, shared by the dispatcher (server/core/notifications.ts), both delivery channels
// (server/utils/webhook.ts, server/utils/apn.ts) and the settings UI's event pickers

export const REQUEST_EVENTS = [
    "request.created",
    "request.accepted",
    "request.denied",
    "request.completed",
    "request.failed"
] as const;

export const NOTIFICATION_EVENTS = [...REQUEST_EVENTS, "release.out"] as const;

export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];

// global (instance) webhooks only ever see request events - a release subscription is one person's business
export const GLOBAL_WEBHOOK_EVENTS: readonly NotificationEvent[] = REQUEST_EVENTS;

export function isNotificationEvent(value: unknown): value is NotificationEvent {
    return typeof value === "string" && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

export const WEBHOOK_FORMATS = ["discord", "slack", "ntfy", "gotify", "json"] as const;
export type WebhookFormat = typeof WEBHOOK_FORMATS[number];

/** what the settings UI gets back - never the full URL, which is a credential in its own right */
export interface WebhookSummary {
    id: string,
    global: boolean,
    name: string,
    format: WebhookFormat,
    urlPreview: string,
    /** null = every event this webhook can receive */
    events: NotificationEvent[] | null,
    enabled: boolean,
    failureCount: number,
    lastError: string | null,
    lastDeliveredAt: number | null,
    createdAt: number
}

/** one notification, channel-agnostic; each webhook format and APNs render it their own way */
export interface NotificationMessage {
    event: NotificationEvent | "test",
    title: string,
    body: string,
    /** small print under the body, e.g. "Requested by alice · Album" */
    footer?: string | null,
    /** absolute deep link into Nafyn, only when NAFYN_PUBLIC_URL is configured */
    url?: string | null,
    /** absolute cover art URL */
    imageUrl?: string | null,
    /** machine-readable details for the generic JSON format */
    data?: Record<string, unknown>
}
