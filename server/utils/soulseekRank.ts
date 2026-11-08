// Orders Soulseek search results for download. Pure (no Nitro auto-imports), so it runs under `bun test`.
//
// A peer's filename is the weakest evidence there is - for a non-Latin title it is often a romanization, mojibake
// or a different spelling than the one searched - but the length the peer's client reports for the file is
// independent of any spelling. So the candidates are tried in order of how close that length is to the one
// MusicBrainz has for the recording first, and only then by what the path says (another take, the title, the
// artist) and how likely the peer is to actually send it; when one fails the fingerprint check the next is downloaded.

import { coreTitle } from "./trackPick";
import { foldMarkerText, languagesOf, versionMarkers, versionOnly, type MarkerKind } from "./versionMarkers";
import { matchKey, nameMatchesAnyTitle } from "./soulseekText";

export interface RankableResult {
    // seconds, as the peer's file reports it (slskd `length`); absent when the peer shares no tag info
    length?: number,
    bitrate?: number,
    speed?: number
}

// further than this from MusicBrainz' length and verification rejects the file anyway (see downloads.ts), so a
// file of unknown length is still worth trying before one this far off
export const DURATION_TOLERANCE_SECONDS = 5;

function knownLength(result: RankableResult): number | null {
    return typeof result.length === "number" && Number.isFinite(result.length) && result.length > 0 ? result.length : null;
}

// 0 = within tolerance, 1 = length unknown, 2 = known and too far off
function band(delta: number | null): 0 | 1 | 2 {
    if (delta === null) return 1;
    return delta <= DURATION_TOLERANCE_SECONDS ? 0 : 2;
}

// `wantedSeconds` <= 0 means MusicBrainz has no length: nothing to rank by, so the order is quality alone.
// The sort is stable, so results the same distance away (or all of them, without a wanted length) keep the order
// they came in - the preferred seller's files first.
export function rankByDuration<T extends RankableResult>(results: T[], wantedSeconds: number): T[] {
    const quality = (a: T, b: T) => (b.bitrate ?? 0) - (a.bitrate ?? 0) || (b.speed ?? 0) - (a.speed ?? 0);
    if (!(wantedSeconds > 0)) return [...results].sort(quality);

    const scored = results.map((result) => {
        const length = knownLength(result);
        const delta = length === null ? null : Math.abs(length - wantedSeconds);
        return { result, delta, band: band(delta) };
    });

    return scored
        .sort((a, b) =>
            a.band - b.band
            || (a.delta ?? 0) - (b.delta ?? 0)
            || quality(a.result, b.result))
        .map((entry) => entry.result);
}

// ---------------------------------------------------------------- one track's candidates

// a filename with one of these is another version of the song that can share its exact runtime (an instrumental
// lines up with the original second for second), so neither the length nor a fingerprint near-miss can be trusted
// to tell them apart: out, unless the requested title itself asks for that version
export const EXCLUDED_VERSION_KEYWORDS = [
    "instrumental", "acapella", "a cappella", "acappella", "karaoke", "backing track", "no vocal", "no vocals",
    "nightcore", "sped up", "speed up", "slowed", "8 bit", "8bit", "music box", "lullaby"
];

// the same words in a FOLDER name are only believed when they are this unmistakable: an album folder called
// "Lullaby" is not an instrumental, but "Instrumentals" is
const FOLDER_EXCLUDED_KEYWORDS = ["instrumental", "instrumentals", "karaoke", "nightcore", "backing track"];

// what a folder name says about the whole album or the whole upload: live recordings, remixes, demos...,
// as phrases (a folder "Live Through This" is a studio album; "Live at Wembley" is not)
const FOLDER_VERSION_PATTERNS: Array<[RegExp, MarkerKind]> = [
    [/\b(?:live (?:at|in|from|on|au|en)|in concert|live session|live sessions|live recordings?|mtv live)\b/, "live"],
    [/\bunplugged\b/, "unplugged"],
    [/\b(?:remixes|remixed|the remix(?:es)? album)\b/, "remix"],
    [/\b(?:demos|rehearsals?|outtakes|bootleg)\b/, "demo"],
    [/\b(?:japanese|korean|chinese|mandarin|english|spanish) (?:ver|version|edition)\b/, "lang:japanese"]
];

// another take or arrangement that is not an outright "other version" of the song: usually a different length,
// which the duration band already catches. Tried after every plain copy, unless the title asks for it.
export const SOFT_VERSION_KEYWORDS = ["extended", "reprise"];

// words a filename carries around the title that say nothing about which recording it is
const NEUTRAL_WORDS = new Set([
    "feat", "ft", "featuring", "with", "official", "audio", "video", "original", "album", "version", "remaster",
    "remastered", "explicit", "clean", "single", "prod", "by", "and", "the", "mix", "radio", "edit", "hq", "hd",
    "mp3", "flac", "kbps", "track", "lyrics", "x", "vs"
]);

const LOSSLESS_EXTENSIONS = [".flac", ".wav", ".alac", ".ape", ".aiff"];

export interface TrackRankTarget {
    title: string,
    altTitles?: string[],
    // MusicBrainz' own note on the recording ("live, 2003: Wembley", "Japanese version"): a version the request is for
    disambiguation?: string | null,
    // the album it was requested from: a live album's tracks are live takes
    album?: string | null,
    artistName: string,
    artistAliases?: string[],
    // seconds, 0 when MusicBrainz doesn't know it
    duration: number
}

export interface TrackRankable extends RankableResult {
    user: string,
    file: string,
    slots: boolean,
    queueLength?: number
}

export interface TrackRanking<T> {
    result: T,
    // nothing about it disagrees: right length, not another version, its filename names the title
    strong: boolean
}

function words(key: string): string[] {
    return key.split(" ").filter(Boolean);
}

function hasPhrase(key: string, phrase: string): boolean {
    return ` ${key} `.includes(` ${phrase} `);
}

function pathParts(file: string): { name: string, folders: string } {
    const parts = file.replace(/\\/g, "/").split("/");
    const base = parts.pop() ?? file;
    const dot = base.lastIndexOf(".");
    return { name: dot > 0 ? base.slice(0, dot) : base, folders: parts.join(" ") };
}

function extensionOf(file: string): string {
    const dot = file.lastIndexOf(".");
    return dot >= 0 ? file.slice(dot).toLowerCase() : "";
}

function asksFor(titleKeys: string[], keyword: string): boolean {
    return titleKeys.some((key) => hasPhrase(key, keyword));
}

/** The title with its brackets and dashed suffix off, and the content of its brackets: each is a way the title is written. */
export function titleForms(target: Pick<TrackRankTarget, "title" | "altTitles">): string[] {
    const forms = new Set<string>();
    for (const title of [target.title, ...(target.altTitles ?? [])]) {
        const trimmed = title.trim();
        if (!trimmed) continue;
        forms.add(trimmed);
        const core = coreTitle(trimmed);
        if (core) forms.add(core);
        // "작은 것들을 위한 시 (Boy With Luv)": the other way it is written is inside the brackets
        for (const match of trimmed.matchAll(/[([{]([^)\]}]+)[)\]}]/g)) {
            const inside = match[1]!.trim();
            // a bracket that is only a version / featuring / remaster note is not a title
            if (inside && !/^(?:feat|ft|featuring|with|from|remaster|original|soundtrack|ost|explicit|clean|\d{4})\b/i.test(inside) && versionMarkers(inside).size === 0) forms.add(inside);
        }
    }
    return [...forms];
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;

function askedMarkers(target: TrackRankTarget): Set<MarkerKind> {
    const asked = new Set<MarkerKind>();
    for (const text of [target.title, ...(target.altTitles ?? []), target.disambiguation, target.album]) {
        if (text) for (const kind of versionMarkers(text)) asked.add(kind);
    }
    return asked;
}

// the markers of a file: its name, with the artist's own words taken out first (an artist called "Live" or "The
// Cover Girls" is not a live or a cover version), plus what its folders say
function fileMarkers(name: string, folders: string, target: TrackRankTarget): Set<MarkerKind> {
    let text = foldMarkerText(name);
    for (const artist of [target.artistName, ...(target.artistAliases ?? [])]) {
        const folded = foldMarkerText(artist);
        if (folded.length >= 2) text = ` ${text} `.split(` ${folded} `).join(" ").trim();
    }
    const markers = versionMarkers(text);
    const folderText = foldMarkerText(folders);
    for (const [pattern, kind] of FOLDER_VERSION_PATTERNS) {
        if (!pattern.test(folderText)) continue;
        if (kind === "lang:japanese") {
            // the folder names which language
            for (const language of languagesOf(versionMarkers(folderText))) markers.add(language);
        } else {
            markers.add(kind);
        }
    }
    return markers;
}

/**
 * True when the file is another version of the song than the one requested: an instrumental, karaoke, nightcore...
 * (the runtime is the original's, so nothing else gives it away), a live take, remix, acoustic, demo, cover... or a
 * version in another language - unless the requested title, its disambiguation or its album asks for that very version.
 * An unmarked file is never "another version" here; the fingerprint and the length judge it.
 */
export function isExcludedVersion(fileName: string, target: TrackRankTarget | Pick<TrackRankTarget, "title" | "altTitles">, folders = ""): boolean {
    const full = { artistName: "", ...target } as TrackRankTarget;
    const name = matchKey(fileName);
    const pathKey = matchKey(`${folders} ${fileName}`);
    const titleKeys = [full.title, ...(full.altTitles ?? [])].map(matchKey);
    if (EXCLUDED_VERSION_KEYWORDS.some((keyword) => hasPhrase(name, keyword) && !asksFor(titleKeys, keyword))) return true;
    if (FOLDER_EXCLUDED_KEYWORDS.some((keyword) => hasPhrase(pathKey, keyword) && !hasPhrase(name, keyword) && !asksFor(titleKeys, keyword))) return true;

    const asked = askedMarkers(full);
    const markers = fileMarkers(fileName, folders, full);

    // live, remix, acoustic, demo, cover...: only when asked for
    for (const kind of versionOnly(markers)) if (!asked.has(kind)) return true;

    // another language: with no language asked for, English is what an unmarked title is, so only another
    // language is held against the file; with one asked for, the file must be in it
    const fileLanguages = languagesOf(markers);
    if (fileLanguages.length > 0) {
        const askedLanguages = languagesOf(asked);
        if (askedLanguages.length === 0 ? fileLanguages.some((kind) => kind !== "lang:english") : !fileLanguages.some((kind) => askedLanguages.includes(kind))) return true;
    }

    // a Latin title followed by kana or hangul that nothing the request is called says ("Song (日本語ver.)", "Song 한국어"):
    // the localized version. (A name that matches only across scripts - romaji for a kana title - is not this.)
    const hasKana = KANA.test(fileName);
    const hasHangul = HANGUL.test(fileName);
    if (hasKana || hasHangul) {
        const forms = [full.title, ...(full.altTitles ?? []), full.artistName, ...(full.artistAliases ?? []), full.album ?? ""].join(" ");
        const latinTitleHit = titleForms(full).filter((form) => !KANA.test(form) && !HANGUL.test(form) && !/\p{Script=Han}/u.test(form))
            .some((form) => hasPhrase(name, matchKey(form)));
        if (latinTitleHit && ((hasKana && !KANA.test(forms)) || (hasHangul && !HANGUL.test(forms)))) return true;
    }
    return false;
}

// a title this short names a hundred songs ("Numéro", "Intro", "12:51"): the artist has to be in the path too
function isWeakTitle(forms: string[]): boolean {
    const keys = forms.map(matchKey).filter(Boolean);
    return keys.length > 0 && keys.every((key) => words(key).length <= 1 || key.length <= 5);
}

/**
 * One track's Soulseek results, best first, unwanted versions dropped. Lexicographic, so a later criterion only
 * ever breaks ties of the earlier ones:
 *   1. length band (within 5 s of MusicBrainz / unknown / further)   2. not another take (live, remix...)
 *   3. how well the filename names the title (exactly / with extra words / only the folder does / nowhere)
 *   4. the artist appears somewhere in the path   5. a free upload slot, then a short queue
 *   6. distance to MusicBrainz' length   7. lossless or >= 256 kbps   8. upload speed
 * The peer's own length goes first because it doesn't depend on how anybody spelled anything.
 */
export function rankForTrack<T extends TrackRankable>(results: T[], target: TrackRankTarget): Array<TrackRanking<T>> {
    const titles = titleForms(target);
    const titleKeys = [target.title, ...(target.altTitles ?? [])].map(matchKey).filter(Boolean);
    const artistKeys = [target.artistName, ...(target.artistAliases ?? [])].map(matchKey).filter((key) => key.length >= 2);
    const known = new Set([...titles.map(matchKey), ...artistKeys].flatMap(words));
    const weakTitle = isWeakTitle(titles);

    const scored = [];
    for (const result of results) {
        const { name, folders } = pathParts(result.file);
        if (isExcludedVersion(name, target, folders)) continue;

        const nameKey = matchKey(name);
        const pathKey = matchKey(`${folders} ${name}`);

        const length = knownLength(result);
        const delta = length === null || !(target.duration > 0) ? null : Math.abs(length - target.duration);
        const durationBand = target.duration > 0 ? band(delta) : 1;

        const anotherTake = SOFT_VERSION_KEYWORDS.some((keyword) => hasPhrase(nameKey, keyword) && !asksFor(titleKeys, keyword)) ? 1 : 0;

        let titleTier: number;
        if (nameMatchesAnyTitle(name, titles)) {
            // what is left once the title, the artist, track numbers and filler words are taken out
            const extras = words(nameKey).filter((word) => !known.has(word) && !NEUTRAL_WORDS.has(word) && !/^\d+$/.test(word));
            titleTier = extras.length === 0 ? 0 : 1;
        } else {
            titleTier = nameMatchesAnyTitle(`${folders} ${name}`, titles) ? 2 : 3;
        }
        // nothing in the path names the song: whatever else it has, it is some other song (the search matched
        // the artist, or a word of the title). With no title at all there is nothing to hold it to.
        if (titleTier === 3 && titles.length > 0) continue;

        const artistInPath = artistKeys.some((key) => hasPhrase(pathKey, key));
        // a one-word title is shared by dozens of songs: without the artist in the path it is anybody's
        if (weakTitle && artistKeys.length > 0 && !artistInPath) continue;

        const artistMissing = artistInPath ? 0 : 1;
        const queue = result.queueLength ?? 0;
        const availability = (result.slots ? 0 : 2) + (queue > 10 ? 1 : 0);
        const lossless = LOSSLESS_EXTENSIONS.includes(extensionOf(result.file));
        const quality = lossless || (result.bitrate ?? 0) >= 256 ? 0 : (result.bitrate ?? 0) >= 192 ? 1 : 2;

        scored.push({
            result,
            keys: [durationBand, anotherTake, titleTier, artistMissing, availability, delta ?? 0, quality, -(result.speed ?? 0)],
            strong: durationBand === 0 && anotherTake === 0 && titleTier <= 1
        });
    }

    // a stable sort: equal candidates keep the order the searches returned them in
    scored.sort((a, b) => {
        for (let i = 0; i < a.keys.length; i++) {
            const difference = a.keys[i]! - b.keys[i]!;
            if (difference !== 0) return difference;
        }
        return 0;
    });
    return scored.map(({ result, strong }) => ({ result, strong }));
}

/**
 * The first `limit` candidates to try, no more than `perUser` from one peer: a peer that stalls on the first file
 * stalls on the next one too, and every stalled attempt costs a minute. Other peers' files come first; the
 * capped ones only fill what is left.
 */
export function pickDiverse<T extends { user: string }>(ranked: T[], limit: number, perUser = 2): T[] {
    const taken: T[] = [];
    const skipped: T[] = [];
    const perPeer = new Map<string, number>();
    for (const candidate of ranked) {
        if (taken.length >= limit) break;
        const count = perPeer.get(candidate.user) ?? 0;
        if (count >= perUser) {
            skipped.push(candidate);
            continue;
        }
        perPeer.set(candidate.user, count + 1);
        taken.push(candidate);
    }
    for (const candidate of skipped) {
        if (taken.length >= limit) break;
        taken.push(candidate);
    }
    return taken;
}
