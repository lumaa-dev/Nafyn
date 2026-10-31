// "did I set Nafyn up correctly?" - checks the environment and says what is missing or wrong.
//
// Two callers share it so they can never disagree:
//   * server/plugins/envCheck.ts logs the problems to the console at every boot;
//   * scripts/check-env.ts (`bun run check:env`) prints the full report and exits non-zero on errors, so it
//     can run before starting the server, in CI, or after editing .env.
//
// Severities mean something specific:
//   error - a feature is broken right now (every download fails, nobody can log in, ...)
//   warn  - it works, but insecurely, or the value is almost certainly not what was meant
//   info  - an optional feature is simply off, or a default is in use
//
// Nothing here talks to the network or the database: it reads variables and looks at files. A wrong-but-
// plausible value (a slskd password that is merely incorrect) is out of its reach; that needs a live probe.
//
// SECURITY: values are never printed, only variable names - this output ends up in container logs.
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { apnSettings } from "./apn";

export type EnvSeverity = "error" | "warn" | "info";
export type EnvGroup = "core" | "downloads" | "integrations" | "notifications" | "deployment";

export interface EnvIssue {
    severity: EnvSeverity,
    group: EnvGroup,
    variable: string,
    message: string,
    fix?: string
}

/** the settings that nuxt.config.ts turns into runtimeConfig - the plugin passes the live ones in */
export interface EnvConfig {
    jwtSecret: string,
    soulseekHost: string,
    soulseekUsername: string,
    soulseekPassword: string,
    soulseekDownloadsPath: string,
    acoustidApiKey: string,
    lastfmApiKey: string,
    domainsWhitelist: string
}

// the built-in defaults of nuxt.config.ts's runtimeConfig - keep in sync with it
const DEFAULT_SOULSEEK_HOST = "http://localhost:5030/";
const DEFAULT_SOULSEEK_USERNAME = "slskd";
const DEFAULT_SOULSEEK_PASSWORD = "slskd";
const DEFAULT_SOULSEEK_DOWNLOADS_PATH = "/music";

// same rule server/utils/jwt.ts enforces when signing
const MIN_JWT_SECRET_LENGTH = 32;
const PLACEHOLDER_JWT_SECRETS = new Set(["change-me-to-a-long-random-string", "secret", "changeme"]);

/** the config as nuxt.config.ts would resolve it from the environment */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
    return {
        jwtSecret: env.JWT_SECRET || "",
        soulseekHost: env.SOULSEEK_HOST || DEFAULT_SOULSEEK_HOST,
        soulseekUsername: env.SOULSEEK_USERNAME || DEFAULT_SOULSEEK_USERNAME,
        soulseekPassword: env.SOULSEEK_PASSWORD || DEFAULT_SOULSEEK_PASSWORD,
        soulseekDownloadsPath: env.SOULSEEK_DOWNLOADS_PATH || DEFAULT_SOULSEEK_DOWNLOADS_PATH,
        acoustidApiKey: env.ACOUSTID_API_KEY || "",
        lastfmApiKey: env.LASTFM_API_KEY || "",
        domainsWhitelist: env.DOMAINS_WHITELIST || ""
    };
}

// every variable that is a free-form string, for the whitespace / stray-quote check
const STRING_VARIABLES = [
    "JWT_SECRET", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_DATABASE",
    "SOULSEEK_HOST", "SOULSEEK_USERNAME", "SOULSEEK_PASSWORD", "SOULSEEK_DOWNLOADS_PATH",
    "ACOUSTID_API_KEY", "LASTFM_API_KEY", "THEAUDIODB_API_KEY",
    "DOMAINS_WHITELIST", "TRUST_PROXY", "NAFYN_PUBLIC_URL", "FPCALC_PATH",
    "APN_KEY_ID", "APN_TEAM_ID", "APN_BUNDLE_ID", "APN_KEY_DIR"
];

// flags that only the exact value "false" switches off (everything else leaves the feature ON)
const OFF_SWITCHES = [
    "NAFYN_INSIGHTS_SCHEDULER", "NAFYN_RETENTION_SCHEDULER", "NAFYN_UNITY_SCHEDULER",
    "NAFYN_NOTIFICATION_SCHEDULER", "NAFYN_UNITY_ENABLED", "NAFYN_IMPORT_WORKER"
];
// tunables read as numbers; a value that isn't one is ignored in favour of the default (code defaults in brackets)
const NUMBER_VARIABLES: Array<[name: string, min: number, integer: boolean]> = [
    ["NAFYN_MAX_ACTIVE_REQUESTS_PER_USER", 1, true], // 500, core/requestCreate.ts
    ["NAFYN_SLSKD_MAX_CONCURRENT_SEARCHES", 1, true], // 3, utils/soulseek.ts
    ["NAFYN_SLSKD_SEARCH_INTERVAL_MS", 0, false] // 1000, utils/soulseek.ts
];
// flags that only the exact value "true" switches on
const ON_SWITCHES = ["NAFYN_PUBLIC_OPENAPI", "NAFYN_WEBHOOK_ALLOW_PRIVATE", "APN_PRODUCTION"];

function onPath(binary: string, env: NodeJS.ProcessEnv): boolean {
    return (env.PATH ?? "").split(delimiter).filter(Boolean).some((dir) => existsSync(join(dir, binary)));
}

/** runs every check against `config` and `env` */
export async function checkEnvironment(config: EnvConfig = configFromEnv(), env: NodeJS.ProcessEnv = process.env): Promise<EnvIssue[]> {
    const issues: EnvIssue[] = [];
    const add = (severity: EnvSeverity, group: EnvGroup, variable: string, message: string, fix?: string) => {
        issues.push({ severity, group, variable, message, fix });
    };

    // -- values that look right but aren't: a trailing space, or quotes that came along from a Docker env file --
    for (const name of STRING_VARIABLES) {
        const value = env[name];
        if (!value) continue;
        if (value !== value.trim()) {
            add("warn", "core", name, "has leading or trailing whitespace, which is part of the value.", "Remove the stray space.");
        } else if (/^(["']).*\1$/.test(value)) {
            add("warn", "core", name, "is wrapped in quotes, and here the quotes are part of the value.", "Drop the quotes (they are only stripped by .env parsers, not by Docker/systemd env files).");
        }
    }

    // -- core -------------------------------------------------------------------------------------------------
    if (!config.jwtSecret) {
        add("error", "core", "JWT_SECRET", "is not set - nobody can log in.", "Set it to a long random string, e.g. `openssl rand -base64 48`.");
    } else if (config.jwtSecret.length < MIN_JWT_SECRET_LENGTH || PLACEHOLDER_JWT_SECRETS.has(config.jwtSecret)) {
        add("error", "core", "JWT_SECRET", `is a placeholder or shorter than ${MIN_JWT_SECRET_LENGTH} characters - Nafyn refuses to sign tokens with it, so nobody can log in.`, "Set it to a long random string, e.g. `openssl rand -base64 48`.");
    }

    const mysqlPort = env.MYSQL_PORT;
    if (mysqlPort !== undefined && mysqlPort !== "" && !(/^\d+$/.test(mysqlPort) && Number(mysqlPort) >= 1 && Number(mysqlPort) <= 65535)) {
        add("error", "core", "MYSQL_PORT", "is not a port number (1-65535).", "MySQL's default is 3306.");
    }
    if (!env.MYSQL_HOST) {
        add("info", "core", "MYSQL_HOST", "is not set, so Nafyn connects to localhost.");
    }
    const mysqlDatabase = env.MYSQL_DATABASE;
    if (mysqlDatabase && !/^[A-Za-z0-9_$]+$/.test(mysqlDatabase)) {
        add("error", "core", "MYSQL_DATABASE", "contains characters MySQL won't accept in a database name unquoted (letters, digits, _ and $ only).", "Pick a simple name like `nafyn`.");
    }
    if ((env.MYSQL_USER ?? "root") === "root" && !env.MYSQL_PASSWORD) {
        add("warn", "core", "MYSQL_PASSWORD", "is empty while connecting as `root`.", "Fine on a throwaway dev box. Otherwise create a dedicated MySQL user with a password.");
    }

    // -- downloads --------------------------------------------------------------------------------------------
    if (!config.acoustidApiKey) {
        add("error", "downloads", "ACOUSTID_API_KEY", "is not set - every download request fails at the start.", "Get a free key at https://acoustid.org/my-applications.");
    }

    let slskdUrl: URL | null = null;
    try {
        slskdUrl = new URL(config.soulseekHost);
    } catch { /* reported below */ }
    if (!slskdUrl || (slskdUrl.protocol !== "http:" && slskdUrl.protocol !== "https:")) {
        add("error", "downloads", "SOULSEEK_HOST", "is not a valid http(s) URL - Nafyn cannot reach slskd.", "Use the full address of slskd's web port, e.g. http://127.0.0.1:5030.");
    } else if (config.soulseekHost === DEFAULT_SOULSEEK_HOST) {
        add("info", "downloads", "SOULSEEK_HOST", `is not set, so Nafyn expects slskd at ${DEFAULT_SOULSEEK_HOST}.`, "Fine only if slskd runs on the same machine.");
    }
    if (config.soulseekUsername === DEFAULT_SOULSEEK_USERNAME && config.soulseekPassword === DEFAULT_SOULSEEK_PASSWORD) {
        add("warn", "downloads", "SOULSEEK_USERNAME / SOULSEEK_PASSWORD", "are slskd's factory login (slskd / slskd).", "Change the login in slskd's configuration, then set both variables to match.");
    }

    const downloads = config.soulseekDownloadsPath;
    if (!existsSync(downloads)) {
        add("error", "downloads", "SOULSEEK_DOWNLOADS_PATH", `${downloads} does not exist on this machine - finished downloads can't be copied in.`, "Point it at slskd's downloads folder as this machine sees it (mount it if slskd runs elsewhere).");
    } else if (!statSync(downloads).isDirectory()) {
        add("error", "downloads", "SOULSEEK_DOWNLOADS_PATH", `${downloads} is not a directory.`);
    } else {
        try {
            accessSync(downloads, constants.R_OK);
            try {
                accessSync(downloads, constants.W_OK);
            } catch {
                add("warn", "downloads", "SOULSEEK_DOWNLOADS_PATH", `${downloads} is readable but not writable - files are copied in, but can't be removed from slskd's folder afterwards.`, "Give Nafyn's user write access (or mount it read-write).");
            }
        } catch {
            add("error", "downloads", "SOULSEEK_DOWNLOADS_PATH", `${downloads} is not readable by Nafyn's user.`);
        }
    }

    // binaries the pipeline shells out to. fpcalc: FPCALC_PATH, else the vendored copy, else PATH
    const fpcalcPath = env.FPCALC_PATH;
    if (fpcalcPath) {
        if (!existsSync(fpcalcPath)) {
            add("error", "downloads", "FPCALC_PATH", `${fpcalcPath} does not exist - downloads can't be fingerprint-verified.`);
        }
    } else if (!existsSync(join(process.cwd(), "vendor", "fpcalc", "fpcalc")) && !onPath("fpcalc", env)) {
        add("error", "downloads", "FPCALC_PATH", "fpcalc (Chromaprint) was not found in vendor/fpcalc/, on PATH, or via FPCALC_PATH - downloads can't be fingerprint-verified.", "Install Chromaprint (`apt install libchromaprint-tools`, `brew install chromaprint`) or set FPCALC_PATH.");
    }
    try {
        const ffmpegPath = (await import("ffmpeg-static")).default as string | null;
        if (!ffmpegPath || !existsSync(ffmpegPath)) {
            add("error", "downloads", "ffmpeg", "the bundled ffmpeg binary is missing - downloaded files can't be retagged.", "Reinstall dependencies (the ffmpeg-static install script has to run).");
        }
    } catch {
        add("error", "downloads", "ffmpeg", "the ffmpeg-static package could not be loaded.", "Reinstall dependencies.");
    }

    // -- optional integrations ----------------------------------------------------------------------------------
    const optionalOff = [
        ["LASTFM_API_KEY", config.lastfmApiKey, "artist bios"]
    ].filter(([, value]) => !value);
    for (const [name, , what] of optionalOff) {
        add("info", "integrations", name!, `is not set - ${what} stay off.`);
    }

    // -- notifications ------------------------------------------------------------------------------------------
    const apn = apnSettings();
    const apnTouched = !!(apn.keyId || apn.teamId || apn.keyPath);
    if (!apnTouched) {
        add("info", "notifications", "APN_KEY_ID / APN_TEAM_ID", "APNs is off (no key id, team id or .p8 key) - the iOS app gets no push notifications, Live Activities or Now Playing sessions.", "See the Apple Push Notifications block in .env.example.");
    } else {
        // Apple names the key file after its Key ID (not a secret), so when it's there the answer is known
        const nameKeyId = /^AuthKey_([A-Z0-9]{10})\.p8$/.exec(apn.keyPath?.split(/[\\/]/).pop() ?? "")?.[1];
        if (!apn.keyId) {
            add("warn", "notifications", "APN_KEY_ID", "is not set, so APNs stays off.", nameKeyId
                ? `The key file is named for ${nameKeyId}, so that is almost certainly the value.`
                : "It is the 10-character Key ID of the .p8 key (Apple Developer -> Keys).");
        } else if (!/^[A-Z0-9]{10}$/.test(apn.keyId)) {
            add("warn", "notifications", "APN_KEY_ID", "should be 10 uppercase letters/digits.", "Copy it from Apple Developer -> Keys.");
        }
        if (!apn.teamId) {
            add("warn", "notifications", "APN_TEAM_ID", "is not set, so APNs stays off.", "It is the 10-character Team ID (Apple Developer -> Membership details).");
        } else if (!/^[A-Z0-9]{10}$/.test(apn.teamId)) {
            add("warn", "notifications", "APN_TEAM_ID", "should be 10 uppercase letters/digits.", "Copy it from Apple Developer -> Membership details.");
        }

        const keyDir = resolve(process.cwd(), apn.keyDir);
        if (!apn.keyPath) {
            let listing = "";
            try { listing = readdirSync(keyDir).length === 0 ? " (the folder is empty)" : ""; } catch { listing = " (the folder can't be read)"; }
            add("warn", "notifications", "APN_KEY_DIR", `no .p8 key found in ${keyDir}${listing}, so APNs stays off.`, "Put the AuthKey_XXXXXXXXXX.p8 file there, or point APN_KEY_DIR at its folder.");
        } else {
            let content = "";
            try { content = readFileSync(apn.keyPath, "utf8"); } catch { /* unreadable, reported below */ }
            if (!content.includes("-----BEGIN PRIVATE KEY-----")) {
                add("error", "notifications", "APN_KEY_DIR", `${apn.keyPath} is not a valid .p8 private key (expected "-----BEGIN PRIVATE KEY-----"), or is unreadable.`, "Re-download the key from Apple Developer; it can only be downloaded once.");
            }
            // Apple names the file after the key id, so a mismatch is the single most common misconfiguration
            const fileKeyId = /^AuthKey_([A-Z0-9]{10})\.p8$/.exec(apn.keyPath.split(/[\\/]/).pop() ?? "")?.[1];
            if (fileKeyId && apn.keyId && fileKeyId !== apn.keyId) {
                add("error", "notifications", "APN_KEY_ID", `is ${apn.keyId}, but the key file is named for ${fileKeyId} - Apple will answer InvalidProviderToken.`, "Make APN_KEY_ID match the file name (or point APN_KEY_DIR at the right key).");
            }
        }
        if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(apn.bundleId)) {
            add("warn", "notifications", "APN_BUNDLE_ID", "doesn't look like a bundle identifier (reverse-DNS, e.g. com.example.Nafyn).", "Use the exact bundle ID of the iOS app.");
        }
        if (apn.legacyNames.length > 0) {
            add("info", "notifications", apn.legacyNames.join(", "), "still work but are deprecated names.", "Rename to APN_KEY_ID, APN_TEAM_ID, APN_BUNDLE_ID, APN_KEY_DIR.");
        }
    }

    const publicUrl = env.NAFYN_PUBLIC_URL;
    if (!publicUrl) {
        add("info", "notifications", "NAFYN_PUBLIC_URL", "is not set - webhook messages and push notifications carry no \"Open in Nafyn\" link.");
    } else {
        try {
            const url = new URL(publicUrl);
            if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
        } catch {
            add("warn", "notifications", "NAFYN_PUBLIC_URL", "is not a valid http(s) URL, so it is ignored and links are left out.", "Use the full address, e.g. https://music.example.com.");
        }
    }
    if (env.NAFYN_WEBHOOK_ALLOW_PRIVATE === "true") {
        add("warn", "notifications", "NAFYN_WEBHOOK_ALLOW_PRIVATE", "is on: instance webhooks (MANAGE_WEBHOOKS holders) can make this server contact private/LAN addresses over plain http.", "Leave it off unless you need a local target such as Home Assistant.");
    }

    // -- deployment ---------------------------------------------------------------------------------------------
    const trustProxy = (env.TRUST_PROXY ?? "").trim().toLowerCase();
    if (trustProxy && trustProxy !== "true" && trustProxy !== "false" && !/^\d+$/.test(trustProxy)) {
        add("warn", "deployment", "TRUST_PROXY", "is not a number - it is read as 0, so X-Forwarded-For is ignored and every client behind your proxy shares one rate-limit bucket.", "Set it to how many reverse proxies sit in front of Nafyn (e.g. 1).");
    } else if (!trustProxy || trustProxy === "0" || trustProxy === "false") {
        add("info", "deployment", "TRUST_PROXY", "is 0: Nafyn assumes it is directly exposed.", "Behind nginx/Caddy/Traefik/Cloudflare, set it to the number of proxies or all clients share one rate limit.");
    }

    for (const host of config.domainsWhitelist.split(",").map((h) => h.trim()).filter(Boolean)) {
        if (!/^[A-Za-z0-9.-]+$/.test(host)) {
            add("warn", "deployment", "DOMAINS_WHITELIST", `entry "${host}" is not a bare hostname (no scheme, path or port) and will never match.`, "Use comma-separated hostnames like home.example.com.");
        }
    }
    if (config.domainsWhitelist.trim()) {
        add("info", "deployment", "DOMAINS_WHITELIST", "is set: the IPs these hostnames resolve to skip the login rate limit.");
    }
    if (env.NAFYN_PUBLIC_OPENAPI === "true") {
        add("info", "deployment", "NAFYN_PUBLIC_OPENAPI", "is on: the API spec and docs UI are public, listing every endpoint to anonymous visitors.");
    }

    for (const name of OFF_SWITCHES) {
        const value = env[name];
        if (value && value !== "false" && value !== "true") {
            add("warn", "deployment", name, `is "${value}" - only the exact value false turns this off, so it is still ON.`);
        }
    }
    for (const [name, min, integer] of NUMBER_VARIABLES) {
        const value = env[name];
        if (!value) continue;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
            add("warn", "downloads", name, `is "${value}", which is not ${integer ? "a whole number" : "a number"} of at least ${min} - the default is used instead.`);
        }
    }
    for (const name of ON_SWITCHES) {
        const value = env[name];
        if (value && value !== "false" && value !== "true") {
            add("warn", "deployment", name, `is "${value}" - only the exact value true turns this on, so it is OFF.`);
        }
    }

    if (!env.NAFYN_PRIVACY_CONTROLLER || !env.NAFYN_PRIVACY_CONTACT) {
        add("info", "deployment", "NAFYN_PRIVACY_CONTROLLER / NAFYN_PRIVACY_CONTACT", "are not both set - the /privacy page tells visitors no contact details were published.", "Fill in who runs this instance and how to reach them about personal data.");
    }

    return issues;
}

const ORDER: Record<EnvSeverity, number> = { error: 0, warn: 1, info: 2 };
const LABEL: Record<EnvSeverity, string> = { error: "ERROR", warn: "WARN ", info: "INFO " };

export function formatIssue(issue: EnvIssue): string {
    return `${issue.variable}: ${issue.message}${issue.fix ? ` ${issue.fix}` : ""}`;
}

/** the full report, grouped by area, worst first - for `bun run check:env` */
export function formatReport(issues: EnvIssue[]): string[] {
    const lines: string[] = [];
    const groups: EnvGroup[] = ["core", "downloads", "integrations", "notifications", "deployment"];
    for (const group of groups) {
        const inGroup = issues.filter((i) => i.group === group).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
        if (inGroup.length === 0) continue;
        lines.push("", group.toUpperCase());
        for (const issue of inGroup) lines.push(`  ${LABEL[issue.severity]} ${formatIssue(issue)}`);
    }
    const count = (severity: EnvSeverity) => issues.filter((i) => i.severity === severity).length;
    lines.push("", `${count("error")} error(s), ${count("warn")} warning(s), ${count("info")} note(s)`);
    return lines;
}

/** boot-time output: errors and warnings in full, notes as one line pointing at the full report */
export function logEnvironmentReport(issues: EnvIssue[]): void {
    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warn");
    const notes = issues.filter((i) => i.severity === "info");

    if (errors.length === 0 && warnings.length === 0) {
        console.info(`[env] configuration looks good${notes.length > 0 ? ` (${notes.length} optional note(s): run \`bun run check:env\`)` : ""}`);
        return;
    }

    console.warn(`[env] ${errors.length} error(s), ${warnings.length} warning(s) in the configuration:`);
    for (const issue of errors) console.error(`[env] ERROR ${formatIssue(issue)}`);
    for (const issue of warnings) console.warn(`[env] WARN  ${formatIssue(issue)}`);
    if (notes.length > 0) console.info(`[env] ${notes.length} optional note(s) hidden - run \`bun run check:env\` for the full report`);
}
