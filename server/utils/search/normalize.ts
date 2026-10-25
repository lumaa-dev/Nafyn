// Text normalization, applied identically to the query and to every candidate.
//
// Two stages, because two different consumers need different amounts of folding:
//   1. `cleanText()`  - NFKC, casefold, Latin accent folding, junk removal (feat. credits, edition words,
//      track numbers, YouTube noise...). The result is still readable text and is what gets sent to
//      MusicBrainz as the query: its Latin analyzers fold accents themselves, but Cyrillic/Greek/CJK must
//      reach it unfolded.
//   2. `normalizeText()` - everything stage 1 does, then the comparison-only folding (Cyrillic/Greek
//      marks, kana, apostrophes, separators), tokenization and stopword removal.
//
// CJK is never transliterated. Katakana is folded onto hiragana for comparison only, and every
// CJK run is kept as characters to be compared by n-grams instead of word tokens.

import type { SearchConfig } from "./config";

export interface NormalizedText {
    original: string,
    /** Stage-1 result: casefolded, junk removed, punctuation intact. Safe to build a MusicBrainz query from. */
    cleaned: string,
    /** Fully normalized comparison string: words + CJK runs, version markers kept, stopwords kept. */
    text: string,
    /** Word tokens (Latin, Cyrillic, Greek and every other spaced script), in order. */
    words: string[],
    /** `words` without stopwords (or `words` itself when everything is a stopword). */
    distinctive: string[],
    /** Every CJK character (no spaces), kana folded to hiragana. */
    cjk: string
}

// scripts written without spaces between words: compared by n-grams
const NGRAM_CHAR = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Thai}\p{Script_Extensions=Lao}\p{Script_Extensions=Khmer}\p{Script_Extensions=Myanmar}]/u;
// scripts where stripping combining marks after NFD is safe (Latin é, Cyrillic ё/й, Greek tonos)
const FOLDABLE_CHAR = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;
const LATIN_CHAR = /\p{Script=Latin}/u;
const MARKS = /\p{M}/gu;

export function isNgramChar(char: string): boolean {
    return NGRAM_CHAR.test(char);
}

export function hasNgramScript(text: string): boolean {
    return NGRAM_CHAR.test(text);
}

// letters NFD can't take apart
const LATIN_SPECIALS: Record<string, string> = {
    "ø": "o", "æ": "ae", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i", "ħ": "h", "ŧ": "t"
};

export function casefold(text: string): string {
    return text.normalize("NFKC")
        .toLowerCase()
        .replace(/ß/g, "ss")
        .replace(/ς/g, "σ");
}

// Latin only: accent-folds é -> e, ø -> o, but leaves everything else (Cyrillic, kana, hangul...) untouched
export function foldLatin(text: string): string {
    let out = "";
    for (const char of text.normalize("NFC")) {
        if (!LATIN_CHAR.test(char)) { out += char; continue; }
        const special = LATIN_SPECIALS[char];
        out += special ?? char.normalize("NFD").replace(MARKS, "");
    }
    return out;
}

// comparison-only: strips the marks of Cyrillic and Greek too (Ё == Е), never of kana/hangul/Han
function foldMarks(text: string): string {
    let out = "";
    for (const char of text.normalize("NFC")) {
        out += FOLDABLE_CHAR.test(char) ? char.normalize("NFD").replace(MARKS, "") : char;
    }
    return out;
}

// katakana U+30A1..U+30F6 -> hiragana U+3041..U+3096. Comparison only: the display text is never touched.
export function foldKana(text: string): string {
    let out = "";
    for (const char of text) {
        const code = char.codePointAt(0)!;
        out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : char;
    }
    return out;
}

// ---------------------------------------------------------------- junk

const AUDIO_EXTENSION = /\.(?:mp3|flac|wav|m4a|aac|ogg|opus|wma|alac|aiff?|ape|mp4|webm|mkv|mka)\s*$/;
// "01 - ", "01. ", "1) ", "(01) ", "01_" : a number *followed by a separator*, so "7 Rings" and "1999" stay
const LEADING_TRACK_NUMBER = /^\s*\d{1,3}(?:\s*[-.):–—]\s+|_+)/;
const LEADING_TAG = /^\s*\[[^\]]{1,24}\]\s*/;

const VIDEO_NOISE_WORDS = "(?:official|music|lyric|lyrics|audio|video|videoclip|visuali[sz]er|mv|m\\/v|hd|hq|4k|1080p|720p|clip officiel|video officielle|audio officiel|paroles|with lyrics|full album|topic)";
const BRACKETED_NOISE = new RegExp(`\\s*[(\\[【]\\s*(?:${VIDEO_NOISE_WORDS}[\\s,\\-–—|/&]*)+[)\\]】]`, "g");
const TRAILING_DASH_NOISE = new RegExp(`\\s*[-–—|~:]\\s*(?:${VIDEO_NOISE_WORDS}\\s*)+$`);
const TRAILING_OFFICIAL_NOISE = /\s+official\s+(?:music\s+|lyric\s+)?(?:video|audio|visuali[sz]er)\s*$/;

const FEAT_BRACKETED = /\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]/g;
// up to the next bracket, so "Song feat. X (Kygo Remix)" keeps its remix marker
const FEAT_FREE = /\s+(?:feat\.?|ft\.?|featuring)\s+(?:(?!\s[-–—]\s)[^([])*/g;

// words that, alone inside a bracket (or after a dash), describe an *edition* of a work and not another work
const EDITION_WORDS = [
    "deluxe", "super", "de luxe", "edition", "version", "remaster", "remastered", "remastering", "remasterise",
    "remasterisee", "remasterizado", "remasterizada", "digitally", "expanded", "bonus", "track", "tracks",
    "anniversary", "reissue", "re-issue", "re issue", "explicit", "clean", "special", "collectors",
    "collector's", "collector s", "limited", "standard", "international", "extended", "original",
    "the", "with", "and", "uk", "us", "japan", "japanese", "european", "digital", "stereo", "mono",
    "リマスター", "デラックス", "版"
];
const EDITION_ONLY = new RegExp(
    `^(?:\\s|\\d{4}|\\d{1,3}(?:st|nd|rd|th)|\\+|-|,|&|${EDITION_WORDS.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})+$`
);
const BRACKET_GROUP = /\s*[([【]([^)\]】]*)[)\]】]/g;
const TRAILING_DASH_GROUP = /\s+[-–—]\s+([^-–—]+)$/;

// edition phrases that are unambiguous even outside brackets
const FREE_EDITION_PHRASES: RegExp[] = [
    /\b(?:(?:19|20)\d{2}\s+)?(?:digitally\s+)?remaster\w*(?:\s+(?:version|edition))?(?:\s+(?:19|20)\d{2})?\b/g,
    /\b(?:super\s+)?de\s?luxe(?:\s+(?:edition|version))?\b/g,
    /\b(?:expanded|anniversary|collector'?s|special|limited|extended|standard|international|bonus(?:\s+tracks?)?|explicit|clean)\s+(?:edition|version)\b/g,
    /\b\d{1,3}(?:st|nd|rd|th)\s+anniversary(?:\s+(?:edition|version|deluxe))*\b/g,
    /\bbonus\s+tracks?\b/g,
    /\bre-?\s?issue\b/g
];

// a bracket is only an edition marker when it says so: "(2011)" or "(The)" alone are part of a title
const EDITION_STRONG = /remaster|deluxe|de luxe|edition|version|expanded|bonus|anniversary|reissue|re-issue|re issue|explicit|clean|special|collector|limited|standard|international|extended|リマスター|デラックス|版/;

function isEditionOnly(content: string): boolean {
    const trimmed = content.trim();
    return trimmed.length > 0 && EDITION_ONLY.test(trimmed) && EDITION_STRONG.test(trimmed);
}

function stripEditions(text: string): string {
    let out = text.replace(BRACKET_GROUP, (match, content: string) => (isEditionOnly(content) ? "" : match));

    // " - 2011 Remaster", " - Deluxe Edition": a trailing dash segment that is nothing but an edition marker
    for (;;) {
        const dash = TRAILING_DASH_GROUP.exec(out);
        if (!dash || !isEditionOnly(dash[1]!)) break;
        out = out.slice(0, dash.index);
    }

    for (const phrase of FREE_EDITION_PHRASES) out = out.replace(phrase, " ");
    return out;
}

/**
 * Stage 1. Keeps markers that name a *different recording*: "(Kygo Remix)", "(Live at ...)", "(Acoustic)".
 */
export function cleanText(raw: string): string {
    let text = foldLatin(casefold(raw)).replace(/[’‘´`ʼ]/g, "'").replace(/\s+/g, " ").trim();

    text = text.replace(LEADING_TAG, "");
    text = text.replace(AUDIO_EXTENSION, "");
    text = text.replace(LEADING_TRACK_NUMBER, "");

    text = text.replace(BRACKETED_NOISE, "");
    text = text.replace(TRAILING_DASH_NOISE, "");
    text = text.replace(TRAILING_OFFICIAL_NOISE, "");

    text = text.replace(FEAT_BRACKETED, "").replace(FEAT_FREE, " ");
    // an apostrophe inside a word must not stop an edition phrase from matching ("collector's edition")
    text = stripEditions(text);

    return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- tokens

const ROMAN_NUMERALS: Record<string, string> = {
    ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9", xi: "11", xii: "12", xiii: "13",
    xiv: "14", xv: "15", xvi: "16", xvii: "17", xviii: "18", xix: "19", xx: "20"
};

const stopwordCache = new WeakMap<object, Map<string, Set<string>>>();

function stopwordSet(config: SearchConfig): Set<string> {
    let bySignature = stopwordCache.get(config.stopwords);
    if (!bySignature) {
        bySignature = new Map();
        stopwordCache.set(config.stopwords, bySignature);
    }
    const signature = config.stopwordLanguages.join(",");
    let set = bySignature.get(signature);
    if (!set) {
        set = new Set(config.stopwordLanguages.flatMap((language) => (config.stopwords[language] ?? []).map((word) => foldMarks(casefold(word)))));
        bySignature.set(signature, set);
    }
    return set;
}

// Stage 2. `cleaned` is stage-1 output.
function toComparable(cleaned: string): string {
    let text = foldKana(foldMarks(cleaned));

    // R.E.M. / U.S.A -> rem / usa: a dot between single letters joins them
    text = text.replace(/(?<![\p{L}\p{N}])(\p{L})\.(?=\p{L}(?:\.|[^\p{L}\p{N}]|$))/gu, "$1");
    // an apostrophe inside a word is deleted ("man's" -> "mans"); any other quote is a separator
    text = text.replace(/(?<=[\p{L}\p{N}])['’‘`´ʼ](?=[\p{L}\p{N}])/gu, "");
    text = text.replace(/&/g, " and ");
    // separators, then whatever punctuation/symbols are left
    text = text.replace(/[_.\-/()[\]+,]/g, " ").replace(/[\p{P}\p{S}]/gu, " ");
    return text.replace(/\s+/g, " ").trim();
}

export function normalizeText(raw: string, config: SearchConfig): NormalizedText {
    const cleaned = cleanText(raw);
    const comparable = toComparable(cleaned);

    const words: string[] = [];
    const pieces: string[] = [];
    let cjk = "";

    for (const chunk of comparable.split(" ")) {
        if (!chunk) continue;
        let word = "";
        let run = "";
        const flushWord = () => {
            if (!word) return;
            const mapped = ROMAN_NUMERALS[word] ?? word;
            words.push(mapped);
            pieces.push(mapped);
            word = "";
        };
        const flushRun = () => {
            if (!run) return;
            cjk += run;
            pieces.push(run);
            run = "";
        };
        for (const char of chunk) {
            if (isNgramChar(char)) { flushWord(); run += char; }
            else { flushRun(); word += char; }
        }
        flushWord();
        flushRun();
    }

    const stop = stopwordSet(config);
    const distinctive = words.filter((word) => !stop.has(word));

    return {
        original: raw,
        cleaned,
        text: pieces.join(" "),
        words,
        distinctive: distinctive.length > 0 ? distinctive : words,
        cjk
    };
}

/** Text folded for substring/keyword tests only: no junk removal, so edition words survive. */
export function foldForKeywords(raw: string): string {
    return toComparable(foldLatin(casefold(raw))).replace(/\s+/g, " ").trim();
}

/** Whole-word (or, for unspaced scripts, substring) containment of an already-folded phrase. */
export function containsPhrase(foldedText: string, foldedPhrase: string): boolean {
    if (!foldedPhrase) return false;
    if (hasNgramScript(foldedPhrase)) return foldedText.includes(foldedPhrase);
    return ` ${foldedText} `.includes(` ${foldedPhrase} `);
}
