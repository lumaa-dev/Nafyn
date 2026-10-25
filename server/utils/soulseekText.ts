// Text handling for Soulseek: what is sent to a search, how a peer's filename is compared with a wanted title,
// and which queries a track or album gets. Pure (no Nitro auto-imports), so it also runs under `bun test`.
//
// Why it exists: a title in kana, hangul or hanzi used to be destroyed on the way. The diacritic fold decomposed
// it (NFD) and never put it back, so 한 reached the network as three conjoining jamo and が as か + U+3099, and
// the "does this filename look like the track" test reduced every non-ASCII character to a space, leaving an
// empty title that matched nothing. Soulseek peers also name files in whatever the uploader's system uses:
// composed or decomposed Unicode, romanized, or - from legacy clients - bytes of a Windows code page that
// slskd decoded as Latin-1.

import { latinize, needsLatinForm, phoneticKey } from "./search/script";
import { foldKana, foldLatin } from "./search/normalize";

/** Latin accents off ("Bénabar" -> "Benabar"); every other script is only recomposed (NFC), never decomposed. */
export function foldDiacritics(text: string): string {
    return foldLatin(text.normalize("NFC"));
}

const MAX_QUERY_CODE_POINTS = 200;

// lone surrogates (an astral character cut in half), the replacement character, control characters and the
// zero-width / bidi marks pasted titles carry: none of them is part of any filename, and a lone surrogate is not
// even valid in the JSON slskd parses
// eslint-disable-next-line no-control-regex -- deliberately strips control characters
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufffd]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The text of a Soulseek search: composed Unicode, fullwidth / halfwidth forms normalized (ＢＴＳ, ｶﾀｶﾅ), Latin
 * accents folded, nothing invisible, no token that is only punctuation (Soulseek reads a leading "-" as "exclude
 * this word"), at most 200 characters, never cut inside a character.
 */
export function soulseekQueryText(text: string): string {
    const clean = text.replace(LONE_SURROGATE, "").replace(INVISIBLE, " ").normalize("NFKC");
    const tokens = foldDiacritics(clean)
        .split(/\s+/)
        .map((token) => token.replace(/^-+/, ""))
        .filter((token) => /[\p{L}\p{N}*]/u.test(token));
    return Array.from(tokens.join(" ")).slice(0, MAX_QUERY_CODE_POINTS).join("").trim();
}

/** The first `skip` characters (code points, not UTF-16 units) dropped: `substring(1)` splits an astral character. */
export function dropLeadingChars(text: string, skip = 1): string {
    return Array.from(text).slice(skip).join("");
}

// ---------------------------------------------------------------- comparing filenames

/**
 * A comparison form: composed, width-folded, Latin accents off, katakana folded onto hiragana, lowercase, every
 * run of anything but letters / digits / marks one space. Letters of every script survive.
 */
export function matchKey(text: string): string {
    return foldKana(foldDiacritics(text.replace(LONE_SURROGATE, "").normalize("NFKC")))
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
        .trim();
}

const LEGACY_ENCODINGS = ["shift_jis", "gbk", "euc-kr", "big5"] as const;

/**
 * Other readings of a filename that came out as mojibake: legacy Soulseek clients send the bytes of their system's
 * code page (UTF-8, Shift_JIS, GBK, EUC-KR), which slskd falls back to reading as Latin-1, so a Japanese title arrives
 * as a string of accented Latin letters.
 * Every reading that decodes cleanly into a script that needs a Latin form is returned, the name itself first.
 */
export function filenameVariants(name: string): string[] {
    const variants = [name];
    // only a name made of nothing above U+00FF can be raw bytes seen as Latin-1
    const codes = Array.from(name, (char) => char.charCodeAt(0));
    if (codes.every((code) => code <= 0xff) && codes.some((code) => code >= 0x80)) {
        const bytes = Uint8Array.from(codes);
        for (const encoding of ["utf-8", ...LEGACY_ENCODINGS]) {
            try {
                const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
                if (decoded !== name && needsLatinForm(decoded) && !variants.includes(decoded)) variants.push(decoded);
            } catch {
                // not that encoding (or the runtime lacks it)
            }
        }
    }
    return variants;
}

const MIN_PHONETIC_KEY = 5;

/**
 * Whether a filename (no folder, no extension) names one of the wanted titles. Same script: the title's words
 * appear in the name. Across scripts (a romanized filename for a Japanese title, or the reverse): the phonetic
 * skeletons are compared, which is looser, so it needs a key long enough to mean something.
 */
export function nameMatchesAnyTitle(name: string, titles: string[]): boolean {
    const wanted = titles.map((title) => ({ title, key: matchKey(title) })).filter((entry) => entry.key);
    if (wanted.length === 0) return false;

    for (const variant of filenameVariants(name)) {
        const key = matchKey(variant);
        if (wanted.some((entry) => key.includes(entry.key))) return true;
    }

    for (const variant of filenameVariants(name)) {
        const squashed = phoneticKey(variant);
        for (const { title } of wanted) {
            if (!needsLatinForm(title) && !needsLatinForm(variant)) continue;
            const wantedKey = phoneticKey(title);
            if (wantedKey.length >= MIN_PHONETIC_KEY && squashed.includes(wantedKey)) return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------- queries

export interface QuerySubject {
    /** The track or album title as MusicBrainz has it. */
    title: string,
    /** The same work under other names (a Latin-script release's title for it). */
    altTitles?: string[],
    artistName: string,
    /** The artist under other names: sort name, credit names, Latin spellings. */
    artistAliases?: string[]
}

const MAX_QUERIES = 8;

function unique(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const key = matchKey(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}

/**
 * Searches to try, best first, for one track or album: the artist and title as MusicBrainz writes them, then in
 * the Latin letters a Western uploader would have used (a Latin release's title, a romanization), then the
 * wildcard forms for a name whose first character is awkward. Peers match on the path, folder included, so the
 * artist and the title may come from different forms.
 */
export function buildSearchQueries(subject: QuerySubject): string[] {
    // a romanization is only worth searching for when it came out as plain Latin: kanji have no reading to give
    // ("二十歳 no 恋" is not a query anybody shared a file under)
    const romanized = (text: string) => (needsLatinForm(text) ? [latinize(text)].filter((latin) => !needsLatinForm(latin)) : []);

    const titles = unique([
        subject.title,
        // the Latin spellings MusicBrainz knows come before a machine romanization
        ...(subject.altTitles ?? []).filter((alt) => !needsLatinForm(alt)),
        ...romanized(subject.title)
    ]).slice(0, 3);

    const latinArtists = (subject.artistAliases ?? []).filter((alias) => !needsLatinForm(alias));
    const artists = unique([
        subject.artistName,
        ...latinArtists,
        ...(latinArtists.length === 0 ? romanized(subject.artistName) : [])
    ]).slice(0, 2);

    const queries: string[] = [];
    const add = (text: string) => queries.push(soulseekQueryText(text));

    const [title, artist] = [titles[0]!, artists[0]!];
    add(`${artist} ${title}`);
    add(`${title} ${artist}`);

    for (const t of titles) {
        for (const a of artists) {
            if (t === title && a === artist) continue;
            add(`${a} ${t}`);
        }
    }

    // the leading character of a Latin name is the one most often written differently ("$uicideboy$", "P!nk");
    // a name in another script has no such first letter to wildcard
    if (!needsLatinForm(artist) && Array.from(artist).length > 3) {
        add(`*${dropLeadingChars(artist)} ${title}`);
        add(`${title} *${dropLeadingChars(artist)}`);
    }

    // an artist-less search for a title long enough to be specific: the folder may carry another spelling
    for (const t of titles) {
        if (matchKey(t).length >= 8) add(t);
    }

    return unique(queries.filter(Boolean)).slice(0, MAX_QUERIES);
}
