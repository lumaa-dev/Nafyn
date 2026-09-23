// maps imported tracks/albums/artists onto MusicBrainz IDs, which is what the download pipeline runs on.
//
// Identifiers first (ISRC for a recording, UPC/EAN barcode for a release), then a strict title + artist
// search as the fallback. The fallback is deliberately conservative: a wrong match downloads the wrong song
// into someone's library, while a missed one just shows up in the failure report where the user can request
// it by hand.
import type { TransferFailReason } from "~~/server/entity/Transfer";
import { getMusicBrainzClient } from "../musicbrainz";
import { foldDiacritics } from "../soulseek";

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const UPC_PATTERN = /^\d{8,14}$/;
const MAX_DURATION_DELTA_MS = 7000;
const MIN_SEARCH_SCORE = 80;

export type MatchResult =
    | { musicbrainzId: string, matchedBy: "isrc" | "upc" | "search" }
    | { failReason: TransferFailReason };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// Lucene special characters, escaped for a quoted MusicBrainz search term
function lucene(value: string): string {
    return value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
}

function normalize(value: string): string {
    return foldDiacritics(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

// drops the decorations services add but MusicBrainz titles don't carry: featured artists, remaster notes,
// "- Single Version"...
function stripDecorations(value: string): string {
    return value
        .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, "")
        .replace(/\s*[([][^)\]]*(?:remaster(?:ed)?|deluxe|expanded|anniversary|edition|bonus track)[^)\]]*[)\]]/gi, "")
        .replace(/\s+-\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|single version|album version|mono|stereo)(?:\s+\d{4})?(?:\s+version)?$/i, "")
        .replace(/\s+(?:feat\.?|ft\.?)\s.+$/i, "")
        .trim();
}

export function coreTitle(value: string): string {
    return normalize(stripDecorations(value));
}

// the first credited artist, without the ", Other Artist" / "feat. X" / "& Y" tail some sources append
function primaryArtist(value: string): string {
    return value.split(/\s*(?:;|,\s|\sfeat\.?\s|\sft\.?\s|\sx\s|\s&\s)\s*/i)[0]!.trim() || value;
}

function artistMatches(credits: Json[] | undefined, wanted: string): boolean {
    const target = normalize(wanted);
    const primary = normalize(primaryArtist(wanted));
    if (!target) return false;
    const names = (credits ?? []).flatMap((c: Json) => [c?.name, c?.artist?.name]).filter((n): n is string => typeof n === "string").map(normalize);
    // whole-word containment only, so "Ye" never matches "Kanye"
    const joined = ` ${names.join(" ")} `;
    return names.some((n) => n === target || n === primary) || (!!primary && joined.includes(` ${primary} `));
}

function durationOk(candidateMs: number | undefined, wantedMs: number | null): boolean {
    if (!candidateMs || !wantedMs) return true;
    return Math.abs(candidateMs - wantedMs) <= MAX_DURATION_DELTA_MS;
}

// prefers a recording that has appeared on the wanted album, then one with an official release, then MusicBrainz's own order
function rankRecordings(recordings: Json[], album: string | null): Json[] {
    const wantedAlbum = album ? coreTitle(album) : null;
    const weight = (r: Json) => {
        const releases: Json[] = r?.releases ?? [];
        let w = 0;
        if (wantedAlbum && releases.some((rel) => coreTitle(rel?.title ?? "") === wantedAlbum)) w += 2;
        if (releases.some((rel) => rel?.status === "Official")) w += 1;
        return w;
    };
    return [...recordings].sort((a, b) => weight(b) - weight(a));
}

export interface TrackToMatch {
    title: string | null,
    artist: string | null,
    album: string | null,
    isrc: string | null,
    durationMs: number | null
}

export async function matchTrack(track: TrackToMatch): Promise<MatchResult> {
    const client = getMusicBrainzClient();
    const isrc = track.isrc?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? null;
    const hasIsrc = !!isrc && ISRC_PATTERN.test(isrc);

    if (hasIsrc) {
        const result: Json = await client.search("recording", { query: `isrc:${isrc}`, limit: 10 }).catch(() => null);
        const recordings: Json[] = result?.recordings ?? [];
        if (recordings.length > 0) {
            // one ISRC can map to several recordings (remasters sharing a code, data-entry mistakes); a title
            // and duration check picks the right one when there's a choice
            const wanted = track.title ? coreTitle(track.title) : null;
            const best = rankRecordings(recordings, track.album).find((r) => (!wanted || coreTitle(r.title ?? "") === wanted) && durationOk(r.length, track.durationMs))
                ?? recordings[0];
            return { musicbrainzId: best.id, matchedBy: "isrc" };
        }
    }

    if (!track.title || !track.artist) {
        return { failReason: hasIsrc ? "not_found" : "missing_data" };
    }

    const title = coreTitle(track.title);
    if (!title) return { failReason: "missing_data" };

    const query = `recording:"${lucene(stripDecorations(track.title))}" AND artist:"${lucene(primaryArtist(track.artist))}"`;
    const result: Json = await client.search("recording", { query, limit: 15 }).catch(() => null);
    const candidates = (result?.recordings ?? []).filter((r: Json) =>
        (r.score ?? 0) >= MIN_SEARCH_SCORE
        && coreTitle(r.title ?? "") === title
        && artistMatches(r["artist-credit"], track.artist!)
        && durationOk(r.length, track.durationMs)
        // a video recording is never what a music library import means
        && !r.video
    );

    const best = rankRecordings(candidates, track.album)[0];
    if (best) return { musicbrainzId: best.id, matchedBy: "search" };

    return { failReason: hasIsrc ? "not_found" : "missing_isrc" };
}

export interface AlbumToMatch {
    title: string | null,
    artist: string | null,
    upc: string | null
}

// resolves to a release-*group* id, which is what an album request (and the album page) runs on
export async function matchAlbum(album: AlbumToMatch): Promise<MatchResult> {
    const client = getMusicBrainzClient();
    const upc = album.upc?.replace(/\D/g, "") ?? null;
    const hasUpc = !!upc && UPC_PATTERN.test(upc);

    if (hasUpc) {
        // barcodes are stored however they were entered: try the code as given and with a leading zero
        // (UPC-A vs EAN-13) before giving up on it
        for (const code of [...new Set([upc, upc.replace(/^0+/, ""), `0${upc}`])]) {
            const result: Json = await client.search("release", { query: `barcode:${code}`, limit: 5 }).catch(() => null);
            const groupId = result?.releases?.find((r: Json) => r?.["release-group"]?.id)?.["release-group"]?.id;
            if (groupId) return { musicbrainzId: groupId, matchedBy: "upc" };
        }
    }

    if (!album.title || !album.artist) return { failReason: hasUpc ? "not_found" : "missing_data" };

    const title = coreTitle(album.title);
    const query = `releasegroup:"${lucene(stripDecorations(album.title))}" AND artist:"${lucene(primaryArtist(album.artist))}"`;
    const result: Json = await client.search("release-group", { query, limit: 10 }).catch(() => null);
    const best = (result?.["release-groups"] ?? []).find((g: Json) =>
        (g.score ?? 0) >= MIN_SEARCH_SCORE
        && coreTitle(g.title ?? "") === title
        && artistMatches(g["artist-credit"], album.artist!)
    );
    if (best) return { musicbrainzId: best.id, matchedBy: "search" };

    return { failReason: hasUpc ? "not_found" : "missing_upc" };
}

export async function matchArtist(name: string | null): Promise<MatchResult> {
    if (!name) return { failReason: "missing_data" };
    const client = getMusicBrainzClient();
    const result: Json = await client.search("artist", { query: `artist:"${lucene(name)}"`, limit: 5 }).catch(() => null);
    const wanted = normalize(name);
    const best = (result?.artists ?? []).find((a: Json) =>
        (a.score ?? 0) >= 90 && (normalize(a.name ?? "") === wanted || (a.aliases ?? []).some((al: Json) => normalize(al?.name ?? "") === wanted))
    );
    return best ? { musicbrainzId: best.id, matchedBy: "search" } : { failReason: "not_found" };
}
