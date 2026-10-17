// `bun run apn:test` - sends a real test push through Apple's servers and says exactly what Apple answered.
// A script on purpose, not an API route: it needs the server's .p8 key and nothing else, and no endpoint
// means nothing for anyone to call remotely.
//
//   bun run apn:test <deviceToken> [--env sandbox|production] [--message "text"]
//   bun run apn:test --user <username> [--message "text"]
//
// <deviceToken> is the hex token the iOS app registers (print it from the app's
// didRegisterForRemoteNotificationsWithDeviceToken, or find it in Settings -> Notifications once registered).
// --user reads that user's registered tokens from the database (read-only) and tests each one against the
// environment it was registered for.
//
// Without --env a token is tried on sandbox first and, if Apple says BadDeviceToken, on production too - a
// debug build and a TestFlight build need different gateways, and "wrong gateway" looks identical to "wrong
// token". Nothing is ever written or deleted: this does not prune tokens, even dead ones.
import { apnEnabled, apnSettings, isValidApnToken, listAlertTargetsForUsername, sendTestAlert, shutdownApn, type ApnEnvironment, type ApnTestResult } from "../server/utils/apn";
import { checkEnvironment } from "../server/utils/envCheck";

const args = process.argv.slice(2).filter((arg) => arg !== "--");

function option(name: string): string | undefined {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
}

function usage(): never {
    console.log(`Usage:
  bun run apn:test <deviceToken> [--env sandbox|production] [--message "text"]
  bun run apn:test --user <username> [--message "text"]`);
    process.exit(2);
}

const username = option("user");
const explicitEnv = option("env");
const message = option("message");
const valueFlags = new Set(["--user", "--env", "--message"]);
const positional = args.filter((arg, i) => !arg.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));
const token = positional[0]?.toLowerCase();

if (explicitEnv !== undefined && explicitEnv !== "sandbox" && explicitEnv !== "production") usage();
if (!username && !token) usage();
if (token && !isValidApnToken(token)) {
    console.error("That doesn't look like an APNs token: expected a long hexadecimal string.");
    process.exit(2);
}

// 1. configuration - the notifications group of the same report `bun run check:env` prints
const settings = apnSettings();
const problems = (await checkEnvironment()).filter((i) => i.group === "notifications" && i.severity !== "info" && i.variable.startsWith("APN_"));
console.log(`key id:   ${settings.keyId || "(not set)"}`);
console.log(`team id:  ${settings.teamId || "(not set)"}`);
console.log(`bundle:   ${settings.bundleId}`);
console.log(`key file: ${settings.keyPath ?? "(none found)"}`);
for (const issue of problems) console.log(`${issue.severity === "error" ? "ERROR" : "WARN "} ${issue.variable}: ${issue.message}${issue.fix ? ` ${issue.fix}` : ""}`);
if (!apnEnabled() || problems.some((i) => i.severity === "error")) {
    console.error("\nAPNs isn't set up yet (see above); no push can be sent until it is.");
    process.exit(1);
}

// 2. what to test
const targets: { token: string, environment: ApnEnvironment | null, label: string }[] = [];
if (username) {
    const registered = await listAlertTargetsForUsername(username);
    if (registered === null) {
        console.error(`\nNo user called "${username}".`);
        process.exit(1);
    }
    if (registered.length === 0) {
        console.error(`\n${username} has no registered notification device. The iOS app registers one at launch once notifications are allowed.`);
        process.exit(1);
    }
    for (const device of registered) targets.push({ token: device.token, environment: device.environment, label: device.deviceName ?? "unnamed device" });
} else {
    targets.push({ token: token!, environment: (explicitEnv as ApnEnvironment | undefined) ?? null, label: "token" });
}

// 3. send
function show(result: ApnTestResult, label: string) {
    const where = `${label} (…${result.token.slice(-8)}, ${result.environment})`;
    if (result.accepted) {
        console.log(`  OK    ${where}: Apple accepted the push - it should arrive within seconds.`);
    } else {
        console.log(`  FAIL  ${where}: ${result.reason ?? "unknown error"}${result.status ? ` (HTTP ${result.status})` : ""}`);
        if (result.hint) console.log(`        ${result.hint}`);
    }
}

console.log("");
let failures = 0;
for (const target of targets) {
    let result = await sendTestAlert(target.token, target.environment ?? "sandbox", message);

    // environment unknown (raw token, no --env): a BadDeviceToken on sandbox may just mean "production token"
    if (!target.environment && !result.accepted && result.reason === "BadDeviceToken") {
        const retry = await sendTestAlert(target.token, "production", message);
        if (retry.accepted) {
            console.log("  (sandbox refused the token but production accepted it: it belongs to a TestFlight/App Store build.)");
            result = retry;
        }
    }

    show(result, target.label);
    if (!result.accepted) failures++;
}

console.log(`\nApple accepting a push only proves the key, team, bundle and token are right. If nothing appears: notifications allowed in iOS Settings, app not in Focus/Do Not Disturb, and the app's aps-environment entitlement matches the token's environment.`);
await shutdownApn();
process.exit(failures > 0 ? 1 : 0);
