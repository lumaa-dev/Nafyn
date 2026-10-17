// notification dispatcher: turns "something happened" into "who hears about it, over which channel".
//
// Delivery lives in the two channel modules - server/utils/webhook.ts and server/utils/apn.ts - and this file
// only decides recipients and wording:
//   * request events go to the requester and every MANAGE_REQUESTS holder (ADMIN included), minus whoever
//     caused the event (a manager doesn't need a push about the request they just accepted), over APNs alerts
//     and their personal webhooks - and to every global (instance) webhook;
//   * a release going out goes to its subscriber only, over APNs and their personal webhooks. Never global.
//
// Every entry point is fire-and-forget: a slow Discord or an APNs outage must never hold up, or fail, the
// request/download/scheduler code path that triggered it. Errors are logged here and go nowhere else.
import type { NafynRequest } from "../entity/NafynRequest";
import type { NotificationEvent, NotificationMessage } from "../entity/Notification";
import { Permission } from "../entity/Permission";
import { getRequestById } from "./requests";
import { getUserDisplayName, listUserIdsWithPermission } from "./users";
import type { DueSubscription } from "./releaseSubscriptions";
import { sendGlobalWebhook, sendWebhookToUsers } from "../utils/webhook";
import {
    endReleaseActivity,
    endRequestActivity,
    sendNotificationToUsers,
    startReleaseActivity,
    startRequestActivity,
    updateRequestActivity,
    type ApnAlert
} from "../utils/apn";
import { onAnyDownloadProgress } from "../utils/downloadEvents";
import { publicUrl } from "../utils/publicUrl";

function fireAndForget(label: string, work: () => Promise<unknown>): void {
    work().catch((err) => console.error(`[notifications] ${label} failed:`, err));
}

function requesterId(request: NafynRequest): string | null {
    if (!request.requestedBy) return null;
    return typeof request.requestedBy === "string" ? request.requestedBy : request.requestedBy.id;
}

function mediaPath(type: "album" | "track", musicbrainzId: string): string {
    return type === "album" ? `/a/${musicbrainzId}` : `/t/${musicbrainzId}`;
}

interface RequestContext {
    requestId: string,
    musicbrainzId: string,
    type: "album" | "track",
    title: string,
    artist: string,
    coverArt: string | null,
    requesterId: string | null,
    requesterName: string
}

async function requestContext(request: NafynRequest): Promise<RequestContext> {
    const id = requesterId(request);
    const name = typeof request.requestedBy === "object" && request.requestedBy
        ? (request.requestedBy.displayName || request.requestedBy.username)
        : id ? await getUserDisplayName(id) : null;
    const artist = request.info ? (typeof request.info.artist === "string" ? request.info.artist : request.info.artist.name) : null;
    return {
        requestId: request.id,
        musicbrainzId: request.musicbrainzId,
        type: request.type,
        title: request.info?.title ?? "Unknown title",
        artist: artist ?? "Unknown artist",
        coverArt: request.info?.coverArt ?? null,
        requesterId: id,
        requesterName: name ?? "a deleted user"
    };
}

const REQUEST_COPY: Record<Extract<NotificationEvent, `request.${string}`>, { title: string, body: (c: RequestContext) => string, key: string }> = {
    "request.created": { title: "New request", body: (c) => `${c.requesterName} requested ${c.title} by ${c.artist}`, key: "REQUEST_CREATED" },
    "request.accepted": { title: "Request accepted", body: (c) => `${c.title} by ${c.artist} was accepted and is being downloaded`, key: "REQUEST_ACCEPTED" },
    "request.denied": { title: "Request denied", body: (c) => `${c.title} by ${c.artist} was denied`, key: "REQUEST_DENIED" },
    "request.completed": { title: "Download complete", body: (c) => `${c.title} by ${c.artist} is ready to play`, key: "REQUEST_COMPLETED" },
    "request.failed": { title: "Download failed", body: (c) => `${c.title} by ${c.artist} could not be downloaded`, key: "REQUEST_FAILED" }
};

async function dispatchRequestEvent(event: keyof typeof REQUEST_COPY, ctx: RequestContext, options: { actorId?: string | null, includeRequester: boolean, detail?: string | null }): Promise<void> {
    const copy = REQUEST_COPY[event];
    const body = options.detail ? `${copy.body(ctx)} (${options.detail})` : copy.body(ctx);

    const managers = await listUserIdsWithPermission(Permission.MANAGE_REQUESTS);
    const recipients = new Set(managers);
    if (options.includeRequester && ctx.requesterId) recipients.add(ctx.requesterId);
    else if (ctx.requesterId) recipients.delete(ctx.requesterId);
    if (options.actorId) recipients.delete(options.actorId);
    const userIds = [...recipients];

    const message: NotificationMessage = {
        event,
        title: copy.title,
        body,
        footer: `Requested by ${ctx.requesterName} · ${ctx.type === "album" ? "Album" : "Track"}`,
        url: publicUrl(mediaPath(ctx.type, ctx.musicbrainzId)),
        imageUrl: ctx.coverArt,
        data: {
            requestId: ctx.requestId,
            musicbrainzId: ctx.musicbrainzId,
            type: ctx.type,
            title: ctx.title,
            artist: ctx.artist,
            requestedBy: ctx.requesterName,
            detail: options.detail ?? null
        }
    };

    // APNs: Localizable.strings keys NAFYN_<KEY>_TITLE / NAFYN_<KEY>_BODY with args [requester, title, artist]
    const alert: ApnAlert = {
        title: copy.title,
        body,
        titleLocKey: `NAFYN_${copy.key}_TITLE`,
        locKey: `NAFYN_${copy.key}_BODY`,
        locArgs: [ctx.requesterName, ctx.title, ctx.artist],
        threadId: `request-${ctx.requestId}`,
        category: "NAFYN_REQUEST",
        imageUrl: ctx.coverArt,
        data: { event, requestId: ctx.requestId, musicbrainzId: ctx.musicbrainzId, type: ctx.type }
    };

    await Promise.allSettled([
        sendNotificationToUsers(userIds, event, alert),
        sendWebhookToUsers(userIds, message),
        sendGlobalWebhook(message)
    ]);
}

function liveActivityAttributes(ctx: RequestContext) {
    return { requestId: ctx.requestId, type: ctx.type, title: ctx.title, artistName: ctx.artist, coverArt: ctx.coverArt };
}

/** A request was just created. Auto-accepted ones also start the requester's Live Activity right away. */
export function notifyRequestCreated(request: NafynRequest, autoAccepted: boolean): void {
    fireAndForget("request.created", async () => {
        const ctx = await requestContext(request);
        await Promise.allSettled([
            dispatchRequestEvent("request.created", ctx, { includeRequester: false, detail: autoAccepted ? "auto-accepted" : null }),
            autoAccepted && ctx.requesterId ? startRequestActivity(ctx.requesterId, liveActivityAttributes(ctx)) : Promise.resolve()
        ]);
    });
}

/** A manager accepted a waiting request; the download starts and so does the requester's Live Activity. */
export function notifyRequestAccepted(request: NafynRequest, actorId: string): void {
    fireAndForget("request.accepted", async () => {
        const ctx = await requestContext(request);
        await Promise.allSettled([
            dispatchRequestEvent("request.accepted", ctx, { actorId, includeRequester: true }),
            ctx.requesterId ? startRequestActivity(ctx.requesterId, liveActivityAttributes(ctx)) : Promise.resolve()
        ]);
    });
}

export function notifyRequestDenied(request: NafynRequest, actorId: string): void {
    fireAndForget("request.denied", async () => {
        const ctx = await requestContext(request);
        await dispatchRequestEvent("request.denied", ctx, { actorId, includeRequester: true });
    });
}

/** The download pipeline is done with a request, one way or the other. */
export function notifyRequestFinished(requestId: string, outcome: "completed" | "failed", detail: string | null = null): void {
    fireAndForget(`request.${outcome}`, async () => {
        await endRequestActivity(requestId, outcome, detail);
        const request = await getRequestById(requestId);
        if (!request) return;
        const ctx = await requestContext(request);
        await dispatchRequestEvent(outcome === "completed" ? "request.completed" : "request.failed", ctx, { includeRequester: true, detail });
    });
}

/** The scheduler hit releaseAt - 3 h for a subscription. */
export function notifyReleaseSoon(sub: DueSubscription): void {
    fireAndForget("release countdown", async () => {
        await startReleaseActivity(sub.userId, {
            subscriptionId: sub.id,
            musicbrainzId: sub.musicbrainzId,
            type: sub.type,
            title: sub.title ?? "Unknown title",
            artistName: sub.artistName ?? "Unknown artist",
            coverArt: sub.coverArt
        }, sub.releaseAt);
    });
}

/** The scheduler hit releaseAt for a subscription: it's out, tell the subscriber (and only them). */
export function notifyReleaseOut(sub: DueSubscription): void {
    fireAndForget("release.out", async () => {
        const title = sub.title ?? "Unknown title";
        const artist = sub.artistName ?? "Unknown artist";
        const body = `${title} by ${artist} is out now`;

        const message: NotificationMessage = {
            event: "release.out",
            title: "Out now",
            body,
            footer: sub.type === "album" ? "Album" : "Track",
            url: publicUrl(mediaPath(sub.type, sub.musicbrainzId)),
            imageUrl: sub.coverArt,
            data: { subscriptionId: sub.id, musicbrainzId: sub.musicbrainzId, type: sub.type, title, artist, releaseDate: sub.releaseDate }
        };

        await Promise.allSettled([
            endReleaseActivity(sub.id, sub.releaseAt),
            sendNotificationToUsers([sub.userId], "release.out", {
                title: "Out now",
                body,
                titleLocKey: "NAFYN_RELEASE_OUT_TITLE",
                locKey: "NAFYN_RELEASE_OUT_BODY",
                locArgs: [title, artist],
                threadId: `release-${sub.musicbrainzId}`,
                category: "NAFYN_RELEASE",
                imageUrl: sub.coverArt,
                data: { event: "release.out", musicbrainzId: sub.musicbrainzId, type: sub.type }
            }),
            sendWebhookToUsers([sub.userId], message)
        ]);
    });
}

let listening = false;

/** Wires download progress into request Live Activities. Idempotent; called from the notifications plugin. */
export function startNotificationListeners(): void {
    if (listening) return;
    listening = true;
    onAnyDownloadProgress((event) => {
        fireAndForget("request activity update", () => updateRequestActivity(event));
    });
}
