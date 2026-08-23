// shared identifier validation.
//
// SECURITY: every one of these IDs ends up in a filesystem path (avatars, playlist covers), an upstream
// URL path (MusicBrainz lookups) or a DB lookup. Validating the *shape* up front is what stops
// `../../../etc/passwd`-style traversal and upstream path injection at the door, rather than relying on
// each individual call site to remember to sanitize.

// canonical UUID (any version), the form randomUUID() emits and every Nafyn/MusicBrainz ID uses
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID_RE.test(value);
}

// throws a 400 unless `value` is a UUID; `what` names the field in the error message
export function assertUuid(value: unknown, what: string): string {
    if (!isUuid(value)) {
        throw createError({ statusCode: 400, statusMessage: `Invalid ${what}` });
    }
    return value;
}

// a MusicBrainz MBID is a plain UUID - validating it keeps a caller-supplied value from being spliced into
// the MusicBrainz REST path (`/ws/2/recording/<id>`) as extra path segments or query string
export function assertMbid(value: unknown, what: string = "MusicBrainz ID"): string {
    return assertUuid(value, what);
}

// escapes the LIKE wildcards `%` and `_` in a user-supplied search term, so a query of "%" can't turn into
// a full-table scan that matches every row (and so a search means what the user typed)
export function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
