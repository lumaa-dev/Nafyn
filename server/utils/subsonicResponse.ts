// minimal Subsonic API (http://www.subsonic.org/pages/api.jsp) response builder: a small generic node tree
// that both the XML and JSON serializers below read from, so every endpoint handler only ever builds one
// shape and gets both output formats for free (`f=json` vs the default XML)
export const SUBSONIC_API_VERSION = "1.16.1";

export type NodeValue = string | number | boolean | undefined | null;

export interface SubsonicNode {
    tag: string,
    attrs?: Record<string, NodeValue>,
    children?: SubsonicNode[]
}

export function el(tag: string, attrs: Record<string, NodeValue> = {}, children: SubsonicNode[] = []): SubsonicNode {
    return { tag, attrs, children };
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function nodeToXml(node: SubsonicNode): string {
    const attrs = Object.entries(node.attrs ?? {})
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
        .join("");

    if (!node.children || node.children.length === 0) return `<${node.tag}${attrs}/>`;
    return `<${node.tag}${attrs}>${node.children.map(nodeToXml).join("")}</${node.tag}>`;
}

// Subsonic's JSON mapping: attributes become plain fields, and every repeatable child element becomes an
// array keyed by its tag name (even a single occurrence), since JSON has no XML-style repeated-element concept
function nodeToJson(node: SubsonicNode): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.attrs ?? {})) {
        if (v !== undefined && v !== null) obj[k] = v;
    }

    const grouped = new Map<string, unknown[]>();
    for (const child of node.children ?? []) {
        const arr = grouped.get(child.tag) ?? [];
        arr.push(nodeToJson(child));
        grouped.set(child.tag, arr);
    }
    for (const [tag, arr] of grouped) obj[tag] = arr;

    return obj;
}

export type SubsonicFormat = "xml" | "json" | "jsonp";

// wraps `body` (the endpoint-specific children, e.g. an `artists` node for getArtists) in the standard
// subsonic-response envelope and writes it in the requested format; `callback` is only used for jsonp
export function sendSubsonicResponse(event: import("h3").H3Event, format: SubsonicFormat, status: "ok" | "failed", body: SubsonicNode[] = [], callback?: string): string {
    const root = el("subsonic-response", { status, version: SUBSONIC_API_VERSION, type: "nafyn" }, body);

    if (format === "xml") {
        setResponseHeader(event, "Content-Type", "text/xml; charset=utf-8");
        return `<?xml version="1.0" encoding="UTF-8"?>${nodeToXml(root)}`;
    }

    const json = JSON.stringify({ "subsonic-response": nodeToJson(root) });
    if (format === "jsonp") {
        setResponseHeader(event, "Content-Type", "application/javascript; charset=utf-8");
        return `${callback ?? "callback"}(${json})`;
    }

    setResponseHeader(event, "Content-Type", "application/json; charset=utf-8");
    return json;
}

export interface SubsonicErrorCode {
    code: number,
    message: string
}

export const SubsonicErrors = {
    generic: (message: string): SubsonicErrorCode => ({ code: 0, message }),
    missingParameter: { code: 10, message: "Required parameter is missing" },
    wrongCredentials: { code: 40, message: "Wrong username or password" },
    tokenAuthNotSupported: { code: 41, message: "Token authentication not supported for this account; use password authentication (p=) instead" },
    notAuthorized: { code: 50, message: "User is not authorized for the given operation" },
    notFound: { code: 70, message: "Requested data was not found" }
} as const;

export function errorNode(err: SubsonicErrorCode): SubsonicNode {
    return el("error", { code: err.code, message: err.message });
}

// thrown by auth or any endpoint handler to short-circuit straight to a Subsonic <error> response,
// instead of the usual Nuxt/H3 createError(...) flow the rest of the app uses - Subsonic clients expect
// errors wrapped in the same envelope as success responses (status="failed" + <error>), always HTTP 200
export class SubsonicApiError extends Error {
    err: SubsonicErrorCode;
    constructor(err: SubsonicErrorCode) {
        super(err.message);
        this.err = err;
    }
}
