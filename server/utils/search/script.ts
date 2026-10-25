// Bridges between writing systems, so a title can be found, compared and searched for in the script the other
// side happens to use: "Hatachi no Koi" <-> 二十歳の恋, "Saranghae" <-> 사랑해, "Kino" <-> Кино.
//
// Nothing here is a dictionary, with one exception (Mandarin readings of Han characters, from `pinyin-pro`):
//   - kana <-> Hepburn/Kunrei romaji, both directions, algorithmic
//   - Hangul -> Revised Romanization, algorithmic (final consonants carry over into a following vowel)
//   - Cyrillic and Greek -> Latin, by table
// What no table can give is the *reading of a kanji* in a Japanese title (二十歳 = hatachi). That reading is
// only ever known from data: MusicBrainz lists the transliterated title a Latin-script release gives the same
// recording, and the engine / download pipeline pass those along as alternative titles.
//
// Pure (no Nitro auto-imports), so it also runs under `bun test`.

import { pinyin } from "pinyin-pro";

// ---------------------------------------------------------------- script detection

const HIRAGANA = /[ぁ-ゖゝ-ゟ]/u;
const KATAKANA = /[ァ-ヺヽ-ヿㇰ-ㇿｦ-ﾟ]/u;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/u;
const HAN = /\p{Script=Han}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const GREEK = /\p{Script=Greek}/u;

export function hasKana(text: string): boolean {
    return HIRAGANA.test(text) || KATAKANA.test(text);
}

/** Anything the functions below can turn into Latin letters, or that needs a Latin form to be searchable. */
export function needsLatinForm(text: string): boolean {
    return hasKana(text) || HANGUL.test(text) || HAN.test(text) || CYRILLIC.test(text) || GREEK.test(text);
}

// ---------------------------------------------------------------- kana -> romaji (Hepburn)

const KANA_ROMAJI: Record<string, string> = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "ゐ": "i", "ゑ": "e", "を": "o", "ん": "n",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ゔ": "vu",
    "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o"
};

// a kana followed by a small ゃ/ゅ/ょ (or a small vowel) is one syllable
const YOON: Record<string, string> = {
    "き": "ky", "ぎ": "gy", "し": "sh", "じ": "j", "ぢ": "j", "ち": "ch", "に": "ny", "ひ": "hy", "び": "by", "ぴ": "py",
    "み": "my", "り": "ry"
};
const SMALL_Y: Record<string, string> = { "ゃ": "a", "ゅ": "u", "ょ": "o" };
const SMALL_VOWEL: Record<string, string> = { "ぁ": "a", "ぃ": "i", "ぅ": "u", "ぇ": "e", "ぉ": "o" };
// foreign-sound combinations: ふぁ -> fa, てぃ -> ti, うぃ -> wi ...
const FOREIGN: Record<string, string> = {
    "ふ": "f", "て": "t", "で": "d", "う": "w", "ゔ": "v", "つ": "ts", "し": "sh", "じ": "j", "ち": "ch", "い": "y"
};

function toHiragana(text: string): string {
    let out = "";
    for (const char of text) {
        const code = char.codePointAt(0)!;
        // katakana U+30A1..U+30F6 -> hiragana, U+30FD/30FE (iteration marks) -> U+309D/309E
        if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCodePoint(code - 0x60);
        else if (code === 0x30fd || code === 0x30fe) out += String.fromCodePoint(code - 0x60);
        // half-width katakana would need a table of its own; NFKC (done by every caller's casefold) turns it into full-width
        else out += char;
    }
    return out;
}

/** Hepburn romaji of the kana in `text`; everything else is left as it is. Long-vowel marks lengthen the vowel. */
export function kanaToRomaji(text: string): string {
    const kana = toHiragana(text);
    const chars = Array.from(kana);
    let out = "";
    let doubleNext = false;

    for (let i = 0; i < chars.length; i++) {
        const char = chars[i]!;
        const next = chars[i + 1];

        if (char === "っ") { doubleNext = true; continue; }
        if (char === "ー") { out += out.match(/[aiueo]$/) ? out.slice(-1) : ""; continue; }

        let syllable: string | undefined;
        let consumed = 1;
        if (next && SMALL_Y[next] && YOON[char]) {
            // しゃ -> sha, じょ -> jo, きゃ -> kya
            syllable = YOON[char]! + SMALL_Y[next]!;
            consumed = 2;
        } else if (next && SMALL_VOWEL[next] && FOREIGN[char]) {
            syllable = FOREIGN[char]! + SMALL_VOWEL[next]!;
            consumed = 2;
        } else if (KANA_ROMAJI[char]) {
            syllable = KANA_ROMAJI[char];
        }

        if (syllable === undefined) {
            out += char;
            doubleNext = false;
            continue;
        }
        if (doubleNext) {
            // っち -> tchi, otherwise the consonant doubles
            syllable = syllable.startsWith("ch") ? `t${syllable}` : `${syllable[0]}${syllable}`;
            doubleNext = false;
        }
        out += syllable;
        i += consumed - 1;
    }
    return out;
}

// ---------------------------------------------------------------- romaji -> kana

// Hepburn, Kunrei-shiki and Nihon-shiki spellings all map onto the same kana ("shi"/"si", "chi"/"ti"/"tyi",
// "sha"/"sya", "tsu"/"tu", "fu"/"hu", "ji"/"zi"/"di"): MusicBrainz' own Latin tracklists use all of them
// ("Hakucyumu", "Nihon Syonen No Natsu").
const ROMAJI_KANA: Record<string, string> = {
    a: "あ", i: "い", u: "う", e: "え", o: "お",
    ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
    sa: "さ", si: "し", shi: "し", su: "す", se: "せ", so: "そ",
    ta: "た", ti: "ち", chi: "ち", tu: "つ", tsu: "つ", te: "て", to: "と",
    na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
    ha: "は", hi: "ひ", hu: "ふ", fu: "ふ", he: "へ", ho: "ほ",
    ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
    ya: "や", yu: "ゆ", yo: "よ",
    ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
    la: "ら", li: "り", lu: "る", le: "れ", lo: "ろ",
    wa: "わ", wo: "を", wi: "うぃ", we: "うぇ",
    ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
    za: "ざ", zi: "じ", ji: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
    da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
    ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
    pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
    va: "ゔぁ", vi: "ゔぃ", vu: "ゔ", ve: "ゔぇ", vo: "ゔぉ",
    kya: "きゃ", kyu: "きゅ", kyo: "きょ",
    sya: "しゃ", syu: "しゅ", syo: "しょ", sha: "しゃ", shu: "しゅ", sho: "しょ", she: "しぇ",
    cya: "ちゃ", cyu: "ちゅ", cyo: "ちょ", tya: "ちゃ", tyu: "ちゅ", tyo: "ちょ",
    cha: "ちゃ", chu: "ちゅ", cho: "ちょ", che: "ちぇ",
    nya: "にゃ", nyu: "にゅ", nyo: "にょ",
    hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ",
    mya: "みゃ", myu: "みゅ", myo: "みょ",
    rya: "りゃ", ryu: "りゅ", ryo: "りょ",
    gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ",
    ja: "じゃ", ju: "じゅ", jo: "じょ", je: "じぇ", jya: "じゃ", jyu: "じゅ", jyo: "じょ",
    zya: "じゃ", zyu: "じゅ", zyo: "じょ",
    dya: "ぢゃ", dyu: "ぢゅ", dyo: "ぢょ",
    bya: "びゃ", byu: "びゅ", byo: "びょ",
    pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ",
    fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ",
    thi: "てぃ", dhi: "でぃ", tsa: "つぁ", tsi: "つぃ", tse: "つぇ", tso: "つぉ"
};
const ROMAJI_KEYS = [...new Set(Object.keys(ROMAJI_KANA))].sort((a, b) => b.length - a.length);
const MAX_ROMAJI_KEY = ROMAJI_KEYS[0]!.length;

const MACRONS: Record<string, string> = { "ā": "aa", "ī": "ii", "ū": "uu", "ē": "ee", "ō": "ou", "â": "aa", "î": "ii", "û": "uu", "ê": "ee", "ô": "ou" };
const ROMAJI_VOWELS = "aiueo";

/**
 * Hiragana for a romaji string, or null when it is not romaji (a stray consonant like the "st" of "Stairway",
 * a letter Japanese has no sound for). Spaces and hyphens are dropped: Japanese is written without them.
 */
export function romajiToKana(text: string): string | null {
    const source = text.toLowerCase().replace(/[āīūēōâîûêô]/g, (char) => MACRONS[char] ?? char).replace(/[\s\-_.]+/g, "");
    if (!source) return null;

    let out = "";
    let sawLetter = false;
    let i = 0;
    while (i < source.length) {
        const char = source[i]!;
        if (!/[a-z]/.test(char)) {
            // digits and other symbols pass through; an apostrophe only separates ("shin'ya")
            if (char !== "'" && char !== "’") out += char;
            i++;
            continue;
        }
        sawLetter = true;

        // ん: "n" before a consonant, at the end, or written "n'" / "nn"
        if (char === "n") {
            const after = source[i + 1];
            const afterIsSound = after !== undefined && (ROMAJI_VOWELS.includes(after) || after === "y");
            if (!afterIsSound) {
                out += "ん";
                i += after === "'" || after === "’" ? 2 : 1;
                continue;
            }
        }

        // っ: a doubled consonant, or the "t" of "tch"
        const after = source[i + 1];
        if (after !== undefined && /[a-z]/.test(after) && !ROMAJI_VOWELS.includes(char) && char !== "n"
            && (after === char || (char === "t" && source.startsWith("ch", i + 1)))) {
            out += "っ";
            i++;
            continue;
        }

        let matched = false;
        for (let length = Math.min(MAX_ROMAJI_KEY, source.length - i); length >= 1; length--) {
            const kana = ROMAJI_KANA[source.slice(i, i + length)];
            if (kana) {
                out += kana;
                i += length;
                matched = true;
                break;
            }
        }
        if (!matched) return null;
    }
    return sawLetter ? out : null;
}

// the grammatical particles are spelled as they sound: "kimi wa" is きみは, "umi e" うみへ, "kimi o" きみを
const PARTICLES: Record<string, [string, string]> = { wa: ["わ", "は"], e: ["え", "へ"], o: ["お", "を"] };
const MAX_KANA_VARIANTS = 4;

/** `romajiToKana`, plus the readings that treat a standalone "wa" / "e" / "o" as the particles は / へ / を. */
export function romajiToKanaVariants(text: string): string[] {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const plain = romajiToKana(words.join(" "));
    if (!plain) return [];

    const variants = new Set<string>([plain]);
    const ambiguous = words.map((word, index) => (PARTICLES[word.toLowerCase()] && words.length > 1 ? index : -1)).filter((index) => index >= 0).slice(0, 3);
    for (let mask = 1; mask < 1 << ambiguous.length && variants.size < MAX_KANA_VARIANTS; mask++) {
        const parts = words.map((word, index) => {
            const bit = ambiguous.indexOf(index);
            if (bit >= 0 && (mask & (1 << bit))) return PARTICLES[word.toLowerCase()]![1];
            return word;
        });
        // the particle words are already kana: the rest still goes through romaji
        const converted = parts.map((part, index) => (ambiguous.includes(index) && Array.from(part).every((char) => /[ぁ-ゖ]/.test(char)) ? part : romajiToKana(part) ?? ""));
        if (converted.every(Boolean)) variants.add(converted.join(""));
    }
    return [...variants];
}

// ---------------------------------------------------------------- hangul -> Revised Romanization

const HANGUL_BASE = 0xac00;
const HANGUL_END = 0xd7a3;
const INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const VOWELS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
// the final consonant as it is pronounced when nothing follows it
const FINALS = ["", "k", "kk", "k", "n", "n", "n", "t", "l", "k", "m", "p", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "h"];
// ...and what moves onto a following vowel-initial syllable (ㅇ): [stays behind, becomes its initial]
const FINAL_LIAISON: Array<[string, string]> = [
    ["", ""], ["", "g"], ["", "kk"], ["k", "s"], ["", "n"], ["n", "j"], ["n", ""], ["", "d"], ["", "r"], ["l", "g"], ["l", "m"],
    ["l", "b"], ["l", "s"], ["l", "t"], ["l", "p"], ["", "r"], ["", "m"], ["", "b"], ["p", "s"], ["", "s"], ["", "ss"], ["ng", ""],
    ["", "j"], ["", "ch"], ["", "k"], ["", "t"], ["", "p"], ["", ""]
];

/** Revised Romanization of the Hangul in `text`; everything else is left as it is. */
export function hangulToRoman(text: string): string {
    const chars = Array.from(text.normalize("NFC"));
    let out = "";
    // a final that moved onto the next syllable
    let carried = "";

    for (let i = 0; i < chars.length; i++) {
        const code = chars[i]!.codePointAt(0)!;
        if (code < HANGUL_BASE || code > HANGUL_END) {
            out += chars[i];
            carried = "";
            continue;
        }
        const index = code - HANGUL_BASE;
        const initial = Math.floor(index / 588);
        const vowel = Math.floor((index % 588) / 28);
        const final = index % 28;

        let head = INITIALS[initial]!;
        if (initial === 11 && carried) head = carried;
        carried = "";

        const nextCode = chars[i + 1]?.codePointAt(0) ?? 0;
        const nextIsVowelInitial = nextCode >= HANGUL_BASE && nextCode <= HANGUL_END && Math.floor((nextCode - HANGUL_BASE) / 588) === 11;

        let tail: string;
        if (final === 0) tail = "";
        else if (nextIsVowelInitial) {
            const [stays, moves] = FINAL_LIAISON[final]!;
            tail = stays;
            carried = moves;
        } else tail = FINALS[final]!;

        out += head + VOWELS[vowel]! + tail;
    }
    return out;
}

// ---------------------------------------------------------------- Cyrillic and Greek

const CYRILLIC_LATIN: Record<string, string> = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k",
    "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    "є": "ye", "і": "i", "ї": "yi", "ґ": "g", "ў": "u", "ђ": "dj", "ј": "j", "љ": "lj", "њ": "nj", "ћ": "c", "џ": "dz"
};
const GREEK_LATIN: Record<string, string> = {
    "α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m",
    "ν": "n", "ξ": "x", "ο": "o", "π": "p", "ρ": "r", "σ": "s", "τ": "t", "υ": "y", "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o"
};

function mapChars(text: string, table: Record<string, string>): string {
    let out = "";
    for (const char of text) out += table[char] ?? table[char.toLowerCase()] ?? char;
    return out;
}

// ---------------------------------------------------------------- Han

/** Mandarin pinyin, syllables separated by a space. Only meaningful for Chinese text. */
export function hanToPinyin(text: string): string {
    return pinyin(text, { toneType: "none", type: "string", nonZh: "consecutive", v: false }).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- Latin forms

/**
 * The text with every script a table can read turned into Latin letters; the rest is untouched. Kana wins over
 * Han (a title with kana is Japanese, so its kanji are not read as Mandarin). Input is expected NFC/NFKC.
 */
export function latinize(text: string): string {
    const source = text.normalize("NFKC");
    if (!needsLatinForm(source)) return source;

    const japanese = hasKana(source);
    let out = "";
    for (const run of source.match(/\p{Script=Hangul}+|\p{Script=Han}+|\p{Script=Cyrillic}+|\p{Script=Greek}+|[\p{Script=Hiragana}\p{Script=Katakana}ー・]+|[^]/gu) ?? []) {
        if (HANGUL.test(run)) out += ` ${hangulToRoman(run)} `;
        else if (HAN.test(run)) out += japanese ? run : ` ${hanToPinyin(run)} `;
        else if (CYRILLIC.test(run)) out += mapChars(run, CYRILLIC_LATIN);
        else if (GREEK.test(run)) out += mapChars(run.normalize("NFD").replace(/\p{M}/gu, ""), GREEK_LATIN);
        else if (hasKana(run)) out += ` ${kanaToRomaji(run)} `;
        else out += run;
    }
    return out.replace(/・/g, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- comparison keys

// Romanizations of one sound differ by system and by writer ("shi"/"si", "tsu"/"tu", "ou"/"o", "eo"/"o",
// "g"/"k"): a comparison key folds all of that, so "Hakucyumu" and "Hakuchūmu" and a machine romanization of
// 白昼夢 land on the same string. Lossy on purpose; only ever compared with another key.
const KEY_REWRITES: Array<[RegExp, string]> = [
    [/[āâ]/g, "a"], [/[īî]/g, "i"], [/[ūû]/g, "u"], [/[ēê]/g, "e"], [/[ōô]/g, "o"],
    [/tch/g, "ch"], [/shi/g, "si"], [/sh/g, "s"], [/chi/g, "ti"], [/ch/g, "t"], [/tsu/g, "tu"], [/ts/g, "t"],
    [/fu/g, "hu"], [/ji/g, "zi"], [/j/g, "z"], [/dz/g, "z"], [/sy/g, "s"], [/zy/g, "z"], [/ty/g, "t"], [/cy/g, "t"],
    [/eo/g, "o"], [/eu/g, "u"], [/ae/g, "e"], [/oe/g, "e"], [/yeo/g, "yo"], [/wo/g, "o"],
    [/ou/g, "o"], [/oo/g, "o"], [/uu/g, "u"], [/aa/g, "a"], [/ii/g, "i"], [/ee/g, "e"], [/oh/g, "o"],
    [/ph/g, "f"], [/v/g, "b"], [/l/g, "r"], [/c/g, "k"], [/q/g, "k"], [/x/g, "ks"],
    [/g/g, "k"], [/d/g, "t"], [/b/g, "p"], [/z/g, "s"], [/(.)\1+/g, "$1"]
];

/** A lossy Latin skeleton of `text` in any supported script; two spellings of one sound share a key. */
export function phoneticKey(text: string): string {
    let key = latinize(text).toLowerCase()
        // accents off, so "ō" has already become "o" by the time the rewrites run
        .normalize("NFD").replace(/\p{M}/gu, "");
    key = key.replace(/[^\p{L}\p{N}]+/gu, "");
    for (const [pattern, replacement] of KEY_REWRITES) key = key.replace(pattern, replacement);
    return key;
}
