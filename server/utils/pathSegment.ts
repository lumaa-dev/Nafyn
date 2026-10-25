// One name (an album, a track) turned into one safe path segment of the music/ library. Pure (no Nitro
// auto-imports), so it also runs under `bun test`.

// a filesystem name is limited in BYTES (255 on ext4/APFS/SMB), not characters: a Japanese, Korean or Chinese
// character is 3 bytes of UTF-8, so a 90-character title overflowed it with `ENAMETOOLONG` while a 200-character
// limit still looked generous. Room is left for the " (99)" disambiguation and the extension.
const MAX_SEGMENT_BYTES = 200;

export function truncateToBytes(text: string, maxBytes: number): string {
    let bytes = 0;
    let out = "";
    // by code point, so an astral character is never cut in half
    for (const char of text) {
        bytes += Buffer.byteLength(char, "utf8");
        if (bytes > maxBytes) break;
        out += char;
    }
    return out;
}

// filesystem-illegal / awkward characters stripped from an album or track name before it becomes a path segment
export function sanitizePathSegment(name: string): string {
    const cleaned = name.normalize("NFC")
        // a lone surrogate or U+FFFD (text that was cut or mis-decoded) is not valid UTF-8 on disk; the zero-width
        // and bidi marks are invisible and only make two names that look alike differ
        .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\ufffd\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
        // eslint-disable-next-line no-control-regex -- deliberately strips control characters too, not just visible punctuation
        .replace(/[/\\:*?"<>|\x00-\x1f]/g, "").replace(/\s+/g, " ").trim()
        // SECURITY: stripping separators isn't enough on its own - an album literally named ".." (which a
        // manual import lets any user type) survives the filter above as a whole path segment, and
        // join("music", "..") lands the file in the app's working directory, outside the library. Leading dots
        // go too, so nothing becomes "." / ".." or a hidden dotfile.
        .replace(/^\.+/, "").trim();
    // a trailing dot or space is dropped by SMB / Windows shares the library may be browsed from
    return truncateToBytes(cleaned, MAX_SEGMENT_BYTES).replace(/[. ]+$/, "") || "Unknown";
}
