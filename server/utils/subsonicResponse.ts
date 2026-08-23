// minimal Subsonic API (http://www.subsonic.org/pages/api.jsp) response builder: a small generic node tree
// that both the XML and JSON serializers below read from, so every endpoint handler only ever builds one
// shape and gets both output formats for free (`f=json` vs the default XML)
export const SUBSONIC_API_VERSION = "1.16.1";

export type NodeValue = string | number | boolean | undefined | null;

export interface SubsonicNode {
    tag: string,
    attrs?: Record<string, NodeValue>,
    children?: SubsonicNode[],
    // JSON only: forces this node to serialize as a single-element array even when it turns out to be the
    // only occurrence of its tag among its siblings. The Subsonic schema fixes, per element, whether it's
    // singular (maxOccurs=1, e.g. the `album` in getAlbum.view) or repeatable (maxOccurs=unbounded, e.g. the
    // `song`s inside it) - XML doesn't care, but JSON does, and strict/typed clients (Codable on iOS
    // especially) reject the wrong shape outright ("data couldn't be read"). Callers building a repeatable
    // list must mark every item with this via asList() below, even when the list currently has just 1 item.
    list?: boolean
}

export function el(tag: string, attrs: Record<string, NodeValue> = {}, children: SubsonicNode[] = [], list: boolean = false): SubsonicNode {
    return { tag, attrs, children, list };
}

// marks a set of sibling nodes as a repeatable list for JSON serialization - see SubsonicNode.list
export function asList(nodes: SubsonicNode[]): SubsonicNode[] {
    return nodes.map((n) => ({ ...n, list: true }));
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

// Subsonic's JSON mapping: attributes become plain fields. A child tag serializes as an array only when
// it's marked repeatable (SubsonicNode.list, see above) or there's genuinely more than one of it; a lone
// occurrence of a non-list tag collapses to a plain object, matching the XSD's maxOccurs=1 elements
// (license, the album in getAlbum.view, etc) - getting this wrong is why strict/typed JSON clients reject
// the response outright with a "wrong format" style error even though the XML equivalent looks identical.
function nodeToJson(node: SubsonicNode): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.attrs ?? {})) {
        if (v !== undefined && v !== null) obj[k] = v;
    }

    const grouped = new Map<string, SubsonicNode[]>();
    for (const child of node.children ?? []) {
        const group = grouped.get(child.tag) ?? [];
        group.push(child);
        grouped.set(child.tag, group);
    }

    for (const [tag, group] of grouped) {
        const values = group.map(nodeToJson);
        const isArray = group.length > 1 || group[0]?.list === true;
        obj[tag] = isArray ? values : values[0];
    }

    return obj;
}

export type SubsonicFormat = "xml" | "json" | "jsonp";

// wraps `body` (the endpoint-specific children, e.g. an `artists` node for getArtists) in the standard
// subsonic-response envelope and writes it in the requested format; `callback` is only used for jsonp
export function sendSubsonicResponse(event: import("h3").H3Event, format: SubsonicFormat, status: "ok" | "failed", body: SubsonicNode[] = [], callback?: string): string {
    if (format === "xml") {
        // xmlns is required on the XML root per the spec - a client parsing against the schema's namespace
        // will reject the response as malformed without it, even though the rest of the document is fine
        const root = el("subsonic-response", { xmlns: "http://subsonic.org/restapi", status, version: SUBSONIC_API_VERSION, type: "nafyn" }, body);
        setResponseHeader(event, "Content-Type", "text/xml; charset=utf-8");
        return `<?xml version="1.0" encoding="UTF-8"?>${nodeToXml(root)}`;
    }

    const root = el("subsonic-response", { status, version: SUBSONIC_API_VERSION, type: "nafyn" }, body);
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
