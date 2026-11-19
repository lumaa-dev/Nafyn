// `bun run fcm:test` - sends a real test push through Firebase Cloud Messaging and says exactly what Google
// answered. The Android counterpart of `bun run apn:test`, a script for the same reason: nothing remotely callable.
//
//   bun run fcm:test <fcmToken> [--message "text"]
//   bun run fcm:test --user <username> [--message "text"]
//
// <fcmToken> is the registration token the Android app registers (shown under Settings -> Notifications in the
// app, debug builds). --user reads that user's registered Android tokens from the database (read-only).
// Nothing is ever written or deleted: dead tokens are reported, not pruned.
import { listAlertTargetsForUsername } from "../server/utils/apn";
import { checkEnvironment } from "../server/utils/envCheck";
import { FCM_FAILURE_HINTS, fcmEnabled, fcmSettings, sendFcm } from "../server/utils/fcm";
import { fcmTestMessage, isValidPushToken } from "../server/utils/fcmPayload";

const args = process.argv.slice(2).filter((arg) => arg !== "--");

function option(name: string): string | undefined {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
}

function usage(): never {
    console.log(`Usage:
  bun run fcm:test <fcmToken> [--message "text"]
  bun run fcm:test --user <username> [--message "text"]`);
    process.exit(2);
}

const username = option("user");
const message = option("message") ?? "FCM is working";
const valueFlags = new Set(["--user", "--message"]);
const token = args.filter((arg, i) => !arg.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""))[0];

if (!username && !token) usage();
if (token && !isValidPushToken("android", token)) {
    console.error("That doesn't look like an FCM registration token.");
    process.exit(2);
}

// 1. configuration
const settings = fcmSettings();
const problems = (await checkEnvironment()).filter((i) => i.group === "notifications" && i.severity !== "info" && i.variable.startsWith("FCM_"));
console.log(`key file: ${settings.path ?? "(not set)"}`);
console.log(`project:  ${settings.projectId ?? "(unknown)"}`);
console.log(`account:  ${settings.clientEmail ?? "(unknown)"}`);
for (const issue of problems) console.log(`${issue.severity === "error" ? "ERROR" : "WARN "} ${issue.variable}: ${issue.message}${issue.fix ? ` ${issue.fix}` : ""}`);
if (!fcmEnabled()) {
    console.error("\nFCM isn't set up yet (see above); no push can be sent until it is.");
    process.exit(1);
}

// 2. what to test
const targets: { token: string, label: string }[] = [];
if (username) {
    const registered = await listAlertTargetsForUsername(username, "android");
    if (registered === null) {
        console.error(`\nNo user called "${username}".`);
        process.exit(1);
    }
    if (registered.length === 0) {
        console.error(`\n${username} has no registered Android device. The Android app registers one at launch once notifications are allowed.`);
        process.exit(1);
    }
    for (const device of registered) targets.push({ token: device.token, label: device.deviceName ?? "unnamed device" });
} else {
    targets.push({ token: token!, label: "token" });
}

// 3. send
console.log("");
let failures = 0;
for (const target of targets) {
    const result = await sendFcm(target.token, fcmTestMessage(message));
    const where = `${target.label} (…${target.token.slice(-8)})`;
    if (result.ok) {
        console.log(`  OK    ${where}: Google accepted the push - it should arrive within seconds.`);
    } else {
        failures++;
        console.log(`  FAIL  ${where}: ${result.reason ?? "unknown error"}${result.status ? ` (HTTP ${result.status})` : ""}`);
        const hint = result.reason ? FCM_FAILURE_HINTS[result.reason] : undefined;
        if (hint) console.log(`        ${hint}`);
    }
}

console.log(`\nGoogle accepting a push only proves the key and the token are right. If nothing appears: notifications allowed for Nafyn in Android settings, the emulator image has Google Play services, and the app was not force-stopped (a force-stopped app receives nothing until opened again).`);
process.exit(failures > 0 ? 1 : 0);
