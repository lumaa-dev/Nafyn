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
    if (!userAgent) return "Unknown device";

    const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
    const os = OSES.find(([re]) => re.test(userAgent))?.[1];

    if (browser && os) return `${browser} on ${os}`;
    if (browser) return browser;
    if (os) return os;
    return "Unknown device";
}
