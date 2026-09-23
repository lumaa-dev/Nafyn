// "Import from a file": the way in for services without a usable public API (Qobuz, or any service when the
// operator hasn't registered developer credentials for it).
//
// Understands:
//   - CSV exports: Exportify (Spotify), TuneMyMusic, Soundiiz and anything else with recognisable column
//     headers (title/artist, plus optional album, ISRC, duration, playlist, UPC)
//   - JSON: Spotify's account data export (YourLibrary.json, Playlist*.json), Apple Music's privacy export
//     (Apple Music Library Tracks.json), or a plain array of { title, artist, ... } objects
//   - plain text, one "Artist - Title" per line
import type { SourceAlbum, SourceTrack } from "./types";
import { num, str } from "./http";
import { splitArtistTitle } from "./titles";

export interface ParsedFileImport {
    tracks: SourceTrack[],
    albums: SourceAlbum[],
    // tracks grouped under a source playlist name, when the file carries one
    playlists: { title: string, tracks: SourceTrack[] }[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const COLUMN_ALIASES: Record<string, string[]> = {
    title: ["track name", "title", "name", "track", "song", "song name", "track title", "song title"],
    artist: ["artist name(s)", "artist name", "artist", "artists", "artist(s)", "artist names", "album artist name(s)"],
    album: ["album name", "album", "album title", "release"],
    isrc: ["isrc", "track isrc"],
    upc: ["upc", "album upc", "barcode", "ean"],
    duration: ["duration (ms)", "track duration (ms)", "duration_ms", "duration", "track duration"],
    playlist: ["playlist name", "playlist", "playlist title"]
};

// RFC 4180-ish: quoted fields, doubled quotes, CRLF/LF, and a delimiter sniffed from the header line
function parseCsv(text: string): string[][] {
    const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
    const delimiter = [",", ";", "\t"].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;

    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (quoted) {
            if (c === "\"") {
                if (text[i + 1] === "\"") { field += "\""; i++; }
                else quoted = false;
            } else field += c;
        } else if (c === "\"" && field.length === 0) quoted = true;
        else if (c === delimiter) { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            field = "";
            if (row.some((f) => f.trim() !== "")) rows.push(row);
            row = [];
        } else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    return rows;
}

// durations come as milliseconds, seconds, or "m:ss"
function parseDuration(value: string | null): number | null {
    if (!value) return null;
    const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (clock) return ((Number(clock[1] ?? 0) * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1000;
    const n = num(value);
    if (n === null || n <= 0) return null;
    return n < 10_000 ? n * 1000 : n;
}

function fromCsv(text: string, fallbackPlaylist: string | null): ParsedFileImport {
    const rows = parseCsv(text);
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/^\uFEFF/, ""));
    const col = (key: string) => header.findIndex((h) => COLUMN_ALIASES[key]!.includes(h));
    const idx = Object.fromEntries(Object.keys(COLUMN_ALIASES).map((k) => [k, col(k)])) as Record<string, number>;

    // header-less file: fall back to "Artist - Title" per line
    if (idx.title === -1) return fromText(text, fallbackPlaylist);

    const cell = (row: string[], key: string) => (idx[key]! >= 0 ? str(row[idx[key]!]) : null);
    const playlists = new Map<string, SourceTrack[]>();
    const tracks: SourceTrack[] = [];

    for (const row of rows) {
        const track: SourceTrack = {
            externalId: null,
            title: cell(row, "title"),
            artist: cell(row, "artist"),
            album: cell(row, "album"),
            isrc: cell(row, "isrc"),
            durationMs: parseDuration(cell(row, "duration"))
        };
        const playlist = cell(row, "playlist") ?? fallbackPlaylist;
        if (playlist) {
            if (!playlists.has(playlist)) playlists.set(playlist, []);
            playlists.get(playlist)!.push(track);
        } else tracks.push(track);
    }

    return { tracks, albums: [], playlists: [...playlists].map(([title, list]) => ({ title, tracks: list })) };
}

function fromText(text: string, fallbackPlaylist: string | null): ParsedFileImport {
    const tracks: SourceTrack[] = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const split = splitArtistTitle(line);
        return { externalId: null, title: split?.title ?? line, artist: split?.artist ?? null, album: null, isrc: null, durationMs: null };
    });
    return fallbackPlaylist ? { tracks: [], albums: [], playlists: [{ title: fallbackPlaylist, tracks }] } : { tracks, albums: [], playlists: [] };
}

function pick(obj: Json, keys: string[]): string | null {
    for (const key of keys) {
        const value = str(obj?.[key]);
        if (value) return value;
    }
    return null;
}

function jsonTrack(t: Json): SourceTrack {
    const inner = t?.track && typeof t.track === "object" ? t.track : t;
    return {
        externalId: pick(inner, ["uri", "id", "trackUri"]),
        title: pick(inner, ["trackName", "track", "title", "Title", "name", "Song Name", "Track Name"]),
        artist: pick(inner, ["artistName", "artist", "Artist", "Artist Name", "artists"]),
        album: pick(inner, ["albumName", "album", "Album", "Album Name"]),
        isrc: pick(inner, ["isrc", "ISRC"]),
        durationMs: parseDuration(pick(inner, ["durationMs", "duration_ms", "Track Duration", "duration"]))
    };
}

function fromJson(json: Json, fallbackPlaylist: string | null): ParsedFileImport {
    // Spotify: YourLibrary.json
    if (json && !Array.isArray(json) && (Array.isArray(json.tracks) || Array.isArray(json.albums)) && !Array.isArray(json.playlists)) {
        return {
            tracks: (json.tracks ?? []).map(jsonTrack),
            albums: (json.albums ?? []).map((a: Json): SourceAlbum => ({ externalId: str(a?.uri), title: pick(a, ["album", "title", "name"]), artist: pick(a, ["artist", "artistName"]), upc: pick(a, ["upc", "UPC"]) })),
            playlists: []
        };
    }

    // Spotify: Playlist1.json
    if (json && Array.isArray(json.playlists)) {
        return {
            tracks: [],
            albums: [],
            playlists: json.playlists.map((p: Json) => ({
                title: str(p?.name) ?? "Imported playlist",
                tracks: (p?.items ?? p?.tracks ?? []).filter((i: Json) => !i?.episode).map(jsonTrack)
            }))
        };
    }

    // a bare array: Apple Music's "Apple Music Library Tracks.json" and generic track lists
    if (Array.isArray(json)) {
        const tracks = json.map(jsonTrack).filter((t) => t.title);
        return fallbackPlaylist ? { tracks: [], albums: [], playlists: [{ title: fallbackPlaylist, tracks }] } : { tracks, albums: [], playlists: [] };
    }

    return { tracks: [], albums: [], playlists: [] };
}

// `playlistName`: when set, loose tracks are grouped into a playlist by that name instead of just being added
export function parseImportFile(filename: string, content: string, playlistName: string | null): ParsedFileImport {
    const lower = filename.toLowerCase();
    const trimmed = content.replace(/^\uFEFF/, "").trim();

    if (lower.endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            return fromJson(JSON.parse(trimmed), playlistName);
        } catch {
            // not actually JSON - fall through to CSV/text
        }
    }
    if (lower.endsWith(".txt")) return fromText(trimmed, playlistName);
    return fromCsv(trimmed, playlistName);
}
