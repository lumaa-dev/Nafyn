// Which version of a song a piece of text names: "(Live at Wembley)", "- Japanese ver.", "(Acoustic)", "[Remix]"...
// A title that differs from the requested one only by such a marker is NOT the same song, however alike the
// rest of it is - the live take, the Japanese version and the original share a title and often their length,
// which is why neither the length nor a stripped-down title comparison can be trusted to tell them apart.
// Pure (no Nitro auto-imports), so it runs under `bun test`. Used on AcoustID candidates (acoustidMatch.ts), on the
// Soulseek filenames (soulseekRank.ts) and on the tags of a downloaded file (tagEvidence.ts).

/** The text with Latin accents off, lowercase, every run of anything but letters / digits one space. */
export function foldMarkerText(text: string): string {
    return text
        .normalize("NFKC")
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .normalize("NFC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

export type MarkerKind =
    | "live" | "remix" | "acoustic" | "instrumental" | "demo" | "cover" | "unplugged" | "altered" | "orchestral" | "piano" | "mashup"
    | "lang:japanese" | "lang:korean" | "lang:chinese" | "lang:english" | "lang:spanish" | "lang:french" | "lang:german" | "lang:portuguese" | "lang:italian" | "lang:russian";

// folded phrases; a phrase made of letters of an unspaced script is matched as a substring, the rest as whole words
const MARKERS: Record<MarkerKind, string[]> = {
    live: ["live", "en vivo", "en direct", "dal vivo", "ao vivo", "ライブ", "らいぶ", "라이브", "现场", "現場", "演唱会", "演唱會", "concert", "in concert"],
    remix: ["remix", "remixed", "remixes", "rmx", "rework", "re work", "reimagined", "リミックス", "리믹스", "混音", "ремикс", "bootleg"],
    acoustic: ["acoustic", "acoustique", "acustico", "アコースティック", "어쿠스틱", "stripped"],
    instrumental: ["instrumental", "instrumentals", "inst", "off vocal", "offvocal", "no vocals", "no vocal", "backing track", "karaoke", "a cappella", "acapella", "acappella", "カラオケ", "インスト", "인스트루멘탈", "반주"],
    demo: ["demo", "rough mix", "rehearsal", "outtake", "unreleased version"],
    cover: ["cover", "tribute", "covered by"],
    unplugged: ["unplugged"],
    altered: ["sped up", "speed up", "slowed", "nightcore", "reverb", "8d audio", "8 bit", "8bit", "music box", "lullaby version"],
    orchestral: ["orchestral", "orchestra version", "symphonic", "string version"],
    piano: ["piano version", "piano ver", "piano arrangement"],
    mashup: ["mashup", "mash up", "medley"],
    "lang:japanese": ["japanese", "japanese ver", "japanese version", "jp ver", "jp version", "jpn", "jap ver", "日本語", "日语", "日語", "일본어"],
    "lang:korean": ["korean", "korean ver", "korean version", "kor ver", "kor version", "kr ver", "한국어", "韩语", "韓語", "韓国語"],
    "lang:chinese": ["chinese", "chinese ver", "chinese version", "mandarin", "cantonese", "chn ver", "中文", "国语", "國語", "粤语", "粵語", "中国語", "중국어"],
    "lang:english": ["english", "english ver", "english version", "eng ver", "eng version", "en ver", "英語", "英语", "영어"],
    "lang:spanish": ["spanish", "spanish ver", "spanish version", "espanol", "version en espanol", "en espanol"],
    "lang:french": ["french", "french ver", "french version", "version francaise", "en francais"],
    "lang:german": ["german", "german ver", "german version", "deutsche version", "auf deutsch"],
    "lang:portuguese": ["portuguese", "portuguese ver", "portuguese version", "versao em portugues", "em portugues"],
    "lang:italian": ["italian", "italian ver", "italian version", "versione italiana", "in italiano"],
    "lang:russian": ["russian", "russian ver", "russian version", "русская версия", "на русском"]
};

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const FOLDED_MARKERS = (Object.entries(MARKERS) as Array<[MarkerKind, string[]]>).map(([kind, phrases]) => ({
    kind,
    phrases: [...new Set(phrases.map(foldMarkerText).filter(Boolean))]
}));

function contains(folded: string, phrase: string): boolean {
    if (UNSPACED.test(phrase)) return folded.includes(phrase);
    return ` ${folded} `.includes(` ${phrase} `);
}

/** Every version marker the text carries. */
export function versionMarkers(text: string): Set<MarkerKind> {
    const folded = foldMarkerText(text);
    const found = new Set<MarkerKind>();
    if (!folded) return found;
    for (const { kind, phrases } of FOLDED_MARKERS) {
        if (phrases.some((phrase) => contains(folded, phrase))) found.add(kind);
    }
    return found;
}

const isLanguage = (kind: MarkerKind) => kind.startsWith("lang:");

/** The markers that are not a language. */
export function versionOnly(markers: Set<MarkerKind>): MarkerKind[] {
    return [...markers].filter((kind) => !isLanguage(kind));
}

/** The languages a text names. */
export function languagesOf(markers: Set<MarkerKind>): MarkerKind[] {
    return [...markers].filter(isLanguage);
}

/**
 * Do these two texts (a candidate's title, the requested title) name different versions? A version marker one has
 * and the other lacks is a different version ("Song (Live)" is not "Song"). A language: a version in another
 * language than the one asked is different; "English" alone is not held against a request that names no language
 * (English is what an unmarked title usually is), and a request that names a language does not mind an unmarked
 * candidate (the original may well be in it).
 */
export function differentVersion(candidateText: string, requestedText: string): boolean {
    const candidate = versionMarkers(candidateText);
    const requested = versionMarkers(requestedText);

    const candidateVersions = new Set(versionOnly(candidate));
    const requestedVersions = new Set(versionOnly(requested));
    for (const kind of candidateVersions) if (!requestedVersions.has(kind)) return true;
    for (const kind of requestedVersions) if (!candidateVersions.has(kind)) return true;

    const candidateLanguages = languagesOf(candidate);
    const requestedLanguages = languagesOf(requested);
    if (candidateLanguages.length > 0) {
        if (requestedLanguages.length === 0) return candidateLanguages.some((kind) => kind !== "lang:english");
        return !candidateLanguages.some((kind) => requestedLanguages.includes(kind));
    }
    return false;
}
