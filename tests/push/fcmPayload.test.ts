import { describe, expect, test } from "bun:test";
import {
    fcmActivityMessage,
    fcmAlertMessage,
    fcmNowPlayingMessage,
    fcmTestMessage,
    isDeadFcmToken,
    isPushPlatform,
    isThrottledFcm,
    isValidPushToken,
    normalizePushToken,
    type FcmMessage
} from "../../server/utils/fcmPayload";

// shaped like a real registration token: instance id, ":", then URL-safe base64
const FCM_TOKEN = "dGVzdC1pbnN0YW5jZQ:APA91bH_kL2xQ-9zR3vT7wYmN8pE4sJ6uC1oB5aD0fG2hI3jK4lM5nO6pQ7rS8tU9vW0xY1zA2bC3dE4fG5hI6jK7lM8nO9pQ0rS1tU2vW3xY4zA5bC6dE7fG8hI9jK0lM1nO2pQ3rS4";
const APN_TOKEN = "a".repeat(64);

function allStrings(message: FcmMessage): boolean {
    return Object.values(message.data).every((value) => typeof value === "string");
}

describe("push tokens", () => {
    test("platforms", () => {
        expect(isPushPlatform("ios")).toBe(true);
        expect(isPushPlatform("android")).toBe(true);
        expect(isPushPlatform("web")).toBe(false);
        expect(isPushPlatform(undefined)).toBe(false);
    });

    test("each platform accepts its own token shape only", () => {
        expect(isValidPushToken("ios", APN_TOKEN)).toBe(true);
        expect(isValidPushToken("ios", FCM_TOKEN)).toBe(false);
        expect(isValidPushToken("android", FCM_TOKEN)).toBe(true);
        expect(isValidPushToken("android", "short")).toBe(false);
        expect(isValidPushToken("android", `${FCM_TOKEN} ; DROP`)).toBe(false);
        expect(isValidPushToken("android", 42)).toBe(false);
    });

    test("APNs tokens are lowercased, FCM tokens never (they are case-sensitive)", () => {
        expect(normalizePushToken("ios", "ABCDEF")).toBe("abcdef");
        expect(normalizePushToken("android", FCM_TOKEN)).toBe(FCM_TOKEN);
    });
});

describe("FCM messages", () => {
    test("an alert carries its localization keys and deep link, as strings", () => {
        const message = fcmAlertMessage({
            title: "Request completed",
            body: "Song - Artist",
            titleLocKey: "NAFYN_REQUEST_COMPLETED_TITLE",
            locKey: "NAFYN_REQUEST_COMPLETED_BODY",
            locArgs: ["alice", "Song", "Artist"],
            threadId: "request-1",
            category: "NAFYN_REQUEST",
            imageUrl: null,
            data: { event: "request.completed", requestId: "1", musicbrainzId: "mbid", type: "track" }
        });
        expect(allStrings(message)).toBe(true);
        expect(message.data.type).toBe("alert");
        expect(message.data.event).toBe("request.completed");
        expect(message.android.priority).toBe("high");
        const payload = JSON.parse(message.data.payload!);
        expect(payload.locArgs).toEqual(["alice", "Song", "Artist"]);
        expect(payload.data.requestId).toBe("1");
        expect("imageUrl" in payload).toBe(false);
    });

    test("activity updates collapse per activity; progress may wait, the rest may not", () => {
        const progress = fcmActivityMessage({
            kind: "request", refId: "req-1", event: "update", priority: 5,
            contentState: { stage: "downloading", progress: 0.4, message: null }
        });
        expect(allStrings(progress)).toBe(true);
        expect(progress.data.type).toBe("request-activity");
        expect(progress.data.refId).toBe("req-1");
        expect(progress.android.priority).toBe("normal");
        expect(progress.android.collapse_key).toBe("request-req-1");
        expect(JSON.parse(progress.data.payload!).state.progress).toBe(0.4);

        const end = fcmActivityMessage({
            kind: "request", refId: "req-1", event: "end", priority: 5,
            contentState: { stage: "completed" }, dismissalDateMs: 1_000
        });
        expect(end.android.priority).toBe("high");
        expect(JSON.parse(end.data.payload!).dismissAt).toBe(1_000);
    });

    test("a release countdown start names its subscription and keeps releaseAt in seconds", () => {
        const start = fcmActivityMessage({
            kind: "release", refId: "sub-1", event: "start",
            attributes: { subscriptionId: "sub-1", title: "Album" },
            contentState: { releaseAt: 1_800_000_000, released: false },
            staleDateMs: 1_800_000_000_000,
            alert: { title: "Album", body: "Artist - out in less than 3 hours" }
        });
        expect(start.data.type).toBe("release-activity");
        const payload = JSON.parse(start.data.payload!);
        expect(payload.state.releaseAt).toBe(1_800_000_000);
        expect(payload.staleAt).toBe(1_800_000_000_000);
        expect(payload.attributes.title).toBe("Album");
    });

    test("now playing and test messages", () => {
        const np = fcmNowPlayingMessage("end", { id: "session-1" });
        expect(np.data).toEqual({ type: "nowplaying", event: "end", refId: "session-1", payload: JSON.stringify({ id: "session-1" }) });
        const t = fcmTestMessage("hello");
        expect(t.data.type).toBe("test");
        expect(JSON.parse(t.data.payload!).body).toBe("hello");
    });
});

describe("FCM errors", () => {
    const body = (status: string, errorCode?: string, message = "") => ({
        error: { status, message, details: errorCode ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] : [] }
    });

    test("dead tokens", () => {
        expect(isDeadFcmToken(404, body("NOT_FOUND", "UNREGISTERED"))).toBe(true);
        expect(isDeadFcmToken(403, body("PERMISSION_DENIED", "SENDER_ID_MISMATCH"))).toBe(true);
        expect(isDeadFcmToken(400, body("INVALID_ARGUMENT", "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token"))).toBe(true);
        // a malformed payload is our bug, not the token's
        expect(isDeadFcmToken(400, body("INVALID_ARGUMENT", "INVALID_ARGUMENT", "Invalid value at 'message.data'"))).toBe(false);
        expect(isDeadFcmToken(429, body("RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"))).toBe(false);
    });

    test("throttling", () => {
        expect(isThrottledFcm(429, body("RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"))).toBe(true);
        expect(isThrottledFcm(503, null)).toBe(true);
        expect(isThrottledFcm(404, body("NOT_FOUND", "UNREGISTERED"))).toBe(false);
    });
});
