// best-effort "Browser on OS" label for a raw User-Agent string, for the Settings -> Sessions list and
// Unity's device labels. No UA-parsing library in this project - a full one is overkill for a label that's
// purely informational, never used for any security/behavioral decision.
const BROWSERS: [RegExp, string][] = [
    [/Edg\//, "Edge"],
    [/OPR\//, "Opera"],
    [/Firefox\//, "Firefox"],
    [/CriOS\//, "Chrome"],
    [/Chrome\//, "Chrome"],
    [/Version\/.*Safari\//, "Safari"],
    [/Safari\//, "Safari"]
];

const OSES: [RegExp, string][] = [
    [/iPhone|iPod/, "iPhone"],
    [/iPad/, "iPad"],
    [/Android/, "Android"],
    [/Mac OS X/, "macOS"],
    [/Windows/, "Windows"],
    [/Linux/, "Linux"]
];

export function labelUserAgent(userAgent: string | null | undefined): string {
    if (!userAgent?.trim()) return "Unknown device";

    const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
    const os = OSES.find(([re]) => re.test(userAgent))?.[1];

    if (browser && os) return `${browser} on ${os}`;
    if (browser) return browser;

    // native app / script in the conventional `Product/version (details)` shape, e.g. `Nafyn/1.0 (iPhone)` ->
    // "Nafyn on iPhone". Browsers all open with `Mozilla/`, so they never reach this and are handled above.
    const product = /^([^\s/()]+)\//.exec(userAgent.trim())?.[1];
    if (product && product !== "Mozilla") {
        const name = product.slice(0, 32);
        return os ? `${name} on ${os}` : name;
    }

    if (os) return os;

    // not a browser: a native app (Safyn sends `appName` as its whole User-Agent) or a script. Show what it
    // called itself rather than hiding it. Client-controlled text, so strip control chars and cap the length.
    const custom = userAgent.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
    return custom || "Unknown device";
}
