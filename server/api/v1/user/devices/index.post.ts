import { APN_DEVICE_KINDS, countDeviceTokens, registerDevice, type ApnDeviceKind } from "~~/server/utils/apn";
import { isPushPlatform, isValidPushToken } from "~~/server/utils/fcmPayload";
import { isNotificationEvent } from "~~/server/entity/Notification";

defineRouteMeta({
    openAPI: {
        description: "Register (or refresh) a push token from a Nafyn app: an APNs token from the iOS app (`platform: ios`, the default) or an FCM registration token from the Android app (`platform: android`). The response is the device it belongs to (all of that login's tokens are one device). The token is bound to the login making the request: logging that session out, or revoking it, unregisters it. On iOS `alert` is the regular device token and the other kinds are push-to-start tokens for request/release Live Activities and iOS 27 Now Playing remote sessions; Android registers its one FCM token under every kind it wants (alerts, request Live Updates, release countdowns, Now Playing of another device). Call again on every launch and whenever a token changes",
        tags: ["user"],
        operationId: "registerAppleDevice",
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        required: ["token", "kind"],
                        properties: {
                            platform: { type: "string", enum: ["ios", "android"], description: "Push service the token belongs to: ios (APNs) or android (FCM). Defaults to ios" },
                            token: { type: "string", description: "Hex-encoded APNs token, or an FCM registration token" },
                            kind: { type: "string", enum: ["alert", "la-start:request", "la-start:release", "nowplaying-start"] },
                            environment: { type: "string", enum: ["sandbox", "production"], description: "APNs gateway the token belongs to: sandbox for Xcode builds, production for TestFlight/App Store. Defaults to production; ignored for android" },
                            deviceName: { type: "string", nullable: true, maxLength: 100 },
                            events: { type: "array", nullable: true, items: { type: "string" }, description: "Alert events this device wants; null = all" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: { "application/json": { schema: { $ref: "#/components/schemas/AppleDevice" } } }
            },
            "400": { description: "Malformed token, kind, environment or events", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "Device limit reached", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

// generous: several devices x four token kinds, and a token rotates now and then
const MAX_DEVICES_PER_USER = 40;

export default defineEventHandler(async (event) => {
    const { sub: userId, jti } = await requireAuthToken(event);
    const body = await readBody(event).catch(() => null);

    const platform = body?.platform ?? "ios";
    if (!isPushPlatform(platform)) {
        throw createError({ statusCode: 400, statusMessage: "platform must be ios or android" });
    }
    if (!isValidPushToken(platform, body?.token)) {
        throw createError({ statusCode: 400, statusMessage: platform === "android" ? "Invalid FCM token" : "Invalid APNs token" });
    }
    if (!(APN_DEVICE_KINDS as readonly string[]).includes(body?.kind)) {
        throw createError({ statusCode: 400, statusMessage: "Unknown token kind" });
    }
    // FCM has one gateway; the column keeps "production" for Android rows
    const environment = platform === "android" ? "production" : body?.environment ?? "production";
    if (environment !== "sandbox" && environment !== "production") {
        throw createError({ statusCode: 400, statusMessage: "environment must be sandbox or production" });
    }
    const events = body?.events ?? null;
    if (events !== null && (!Array.isArray(events) || !events.every(isNotificationEvent))) {
        throw createError({ statusCode: 400, statusMessage: "Unknown notification event" });
    }
    const deviceName = typeof body?.deviceName === "string" && body.deviceName.trim() ? body.deviceName.trim().slice(0, 100) : null;

    if (await countDeviceTokens(userId) >= MAX_DEVICES_PER_USER) {
        throw createError({ statusCode: 409, statusMessage: `At most ${MAX_DEVICES_PER_USER} device tokens - remove one first` });
    }

    return await registerDevice(userId, jti, {
        platform,
        token: body.token,
        kind: body.kind as ApnDeviceKind,
        environment,
        deviceName,
        events
    });
});
