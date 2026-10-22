// Every tunable of the search engine in one place. Nothing here reads Nitro auto-imports, so the whole
// search folder also runs under `bun test`.

export type PrimaryType = "album" | "ep" | "single" | "broadcast" | "other";

export interface SearchConfig {
    // ---- retrieval ----
    /** Candidates asked from MusicBrainz per search (then filtered, scored and capped to the caller's limit). */
    candidatePool: number,
    /** Most candidates that get the (network-bound) hard-filter and cover-art checks, best first. */
    maxVerified: number,

    // ---- scoring ----
    /** Levenshtein ratio (0..1) at which two Latin/Cyrillic/Greek words count as the same word (typo tolerance). */
    tokenTypoRatio: number,
    /** Words shorter than this must match exactly - a one-letter typo in "man" is a different word. */
    typoMinLength: number,
    /** Artist similarity below this drops a candidate when an artist was requested. */
    artistFloor: number,
    /** Relevance below this is discarded *before* ranking, so an irrelevant covered result can't surface. */
    minRelevance: number,
    /** Multiplier applied to the title score for every distinctive word the candidate has and the request lacks. */
    extraTokenPenalty: number,
    /** A CJK candidate carrying at least this many characters the request did not ask for is a different work. */
    cjkExtraCharsReject: number,
    /** Weight of the title and the artist in the relevance (a part that was not requested has no weight). */
    titleWeight: number,
    artistWeight: number,
    /** Score added per additional recall angle (album search, recording search, alias search...) a candidate surfaced from. */
    corroborationBonus: number,
    corroborationBonusCap: number,
    /** Score added to a candidate found by a UPC/ISRC that is consistent with the requested title/artist. */
    codeMatchBonus: number,
    /** Multiplier on the score of a code hit whose title/artist contradict the request. */
    codeContradictionFactor: number,
    /** A code hit scoring under this title/artist similarity is considered contradicting the request. */
    codeContradictionBelow: number,
    /** Multiplier for an interpretation of a free-text query as "just an artist" (so a title match outranks it). */
    artistOnlyFactor: number,

    // ---- ranking ----
    /** Preference order when everything else ties; earlier wins. */
    primaryTypeOrder: PrimaryType[],

    // ---- best_result ----
    bestResultMinScore: number,
    /** The top result must beat the runner-up by this much, or nobody is flagged (ambiguous). */
    bestResultMargin: number,

    // ---- filters ----
    /** Words (any supported language) marking a "best of" / greatest-hits compilation in a title. */
    compilationKeywords: string[],
    /** Edition words that make a release a deluxe edition. */
    deluxeKeywords: string[],
    /** Words that make a release a remaster. */
    remasterKeywords: string[],
    /** Release-group secondary types that are never wanted. */
    excludedSecondaryTypes: string[],

    // ---- normalization ----
    /** Stopwords ignored for matching only, per language. */
    stopwords: Record<string, string[]>,
    /** Languages from `stopwords` in use. */
    stopwordLanguages: string[],

    // ---- cover art ----
    coverArtTimeoutMs: number,
    coverArtConcurrency: number
}

export const DEFAULT_STOPWORDS: Record<string, string[]> = {
    en: ["the", "a", "an", "of", "and", "or", "to", "in", "on", "at", "for", "with", "by", "from", "is", "it"],
    fr: ["le", "la", "les", "l", "un", "une", "des", "de", "du", "d", "et", "ou", "au", "aux", "en", "dans", "sur", "pour", "avec", "par", "qui", "que"],
    de: ["der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "und", "oder", "von", "zu", "im", "mit", "für", "auf", "ist"],
    es: ["el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "y", "o", "en", "con", "por", "para", "al", "que"],
    it: ["il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "del", "della", "dei", "e", "o", "in", "con", "per", "da", "che"],
    pt: ["o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "e", "ou", "em", "no", "na", "com", "por", "para", "que"],
    ru: ["и", "в", "во", "не", "на", "с", "со", "а", "но", "к", "ко", "о", "об", "от", "по", "за", "из", "у", "для", "то"]
};

// matched on normalized (accent-folded, casefolded) text, so they are listed folded; multi-word entries are phrases
export const DEFAULT_COMPILATION_KEYWORDS: string[] = [
    // English
    "best of", "greatest hits", "the very best", "very best of", "essentials", "the essential", "anthology",
    "collection", "the collection", "hits collection", "number ones", "ultimate hits", "all the hits",
    "singles collection", "the definitive", "definitive collection", "retrospective", "complete hits",
    // French
    "le meilleur", "meilleur de", "les meilleurs", "le meilleur de", "tous les tubes", "integrale",
    // German / Spanish / Italian / Portuguese
    "das beste", "beste von", "grosste hits", "grandes exitos", "lo mejor de", "exitos", "il meglio", "il meglio di",
    "o melhor de", "os melhores", "grandes sucessos",
    // Russian
    "лучшее", "лучшие песни", "лучшие хиты", "избранное", "золотая коллекция", "антология",
    // Japanese
    "ベスト", "べすと", "ベストアルバム", "コレクション", "全曲集", "名曲集", "セレクション",
    // Chinese
    "精选", "精選", "最佳", "金曲", "合集", "珍藏",
    // Korean
    "베스트", "히트곡", "컬렉션"
];

export const DEFAULT_DELUXE_KEYWORDS: string[] = [
    "deluxe", "super deluxe", "expanded", "anniversary edition", "collector s edition", "special edition", "limited edition",
    "デラックス", "豪华版", "豪華版", "디럭스", "deluxe edition", "extended edition"
];

export const DEFAULT_REMASTER_KEYWORDS: string[] = [
    "remaster", "remastered", "remasterise", "remasterisee", "remasterizado", "remasterizada", "remasterizzato",
    "remasterisiert", "remasterizado", "リマスター", "重制", "重新母带", "리마스터", "ремастер", "ремастеринг"
];

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
    candidatePool: 40,
    maxVerified: 18,

    tokenTypoRatio: 0.85,
    typoMinLength: 4,
    artistFloor: 0.6,
    minRelevance: 0.55,
    extraTokenPenalty: 0.65,
    cjkExtraCharsReject: 2,
    titleWeight: 0.6,
    artistWeight: 0.4,
    corroborationBonus: 0.02,
    corroborationBonusCap: 0.06,
    codeMatchBonus: 0.15,
    codeContradictionFactor: 0.5,
    codeContradictionBelow: 0.5,
    artistOnlyFactor: 0.9,

    primaryTypeOrder: ["album", "ep", "single", "broadcast", "other"],

    bestResultMinScore: 0.8,
    bestResultMargin: 0.08,

    compilationKeywords: DEFAULT_COMPILATION_KEYWORDS,
    deluxeKeywords: DEFAULT_DELUXE_KEYWORDS,
    remasterKeywords: DEFAULT_REMASTER_KEYWORDS,
    excludedSecondaryTypes: ["compilation", "bootleg", "demo", "interview", "audiobook", "audio drama", "spokenword"],

    stopwords: DEFAULT_STOPWORDS,
    stopwordLanguages: ["en", "fr", "de", "es", "it", "pt", "ru"],

    coverArtTimeoutMs: 4000,
    coverArtConcurrency: 4
};

export function resolveSearchConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
    return { ...DEFAULT_SEARCH_CONFIG, ...overrides };
}

function envNumber(env: Record<string, string | undefined>, name: string): number | undefined {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function envList(env: Record<string, string | undefined>, name: string): string[] | undefined {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

// operator overrides, all optional. The keyword lists *extend* the built-in ones (replace nothing),
// `NAFYN_SEARCH_STOPWORD_LANGUAGES` selects which of the bundled stopword languages are used.
export function searchConfigFromEnv(env: Record<string, string | undefined> = process.env): SearchConfig {
    const overrides: Partial<SearchConfig> = {};

    const numbers: Array<[keyof SearchConfig, string]> = [
        ["minRelevance", "NAFYN_SEARCH_MIN_RELEVANCE"],
        ["artistFloor", "NAFYN_SEARCH_ARTIST_FLOOR"],
        ["bestResultMinScore", "NAFYN_SEARCH_BEST_MIN_SCORE"],
        ["bestResultMargin", "NAFYN_SEARCH_BEST_MARGIN"],
        ["candidatePool", "NAFYN_SEARCH_CANDIDATE_POOL"]
    ];
    for (const [key, name] of numbers) {
        const value = envNumber(env, name);
        if (value !== undefined) (overrides as Record<string, unknown>)[key] = value;
    }

    const extraCompilation = envList(env, "NAFYN_SEARCH_COMPILATION_KEYWORDS");
    if (extraCompilation) overrides.compilationKeywords = [...DEFAULT_COMPILATION_KEYWORDS, ...extraCompilation];

    const languages = envList(env, "NAFYN_SEARCH_STOPWORD_LANGUAGES");
    if (languages) overrides.stopwordLanguages = languages.filter((language) => language in DEFAULT_STOPWORDS);

    const order = envList(env, "NAFYN_SEARCH_PRIMARY_TYPE_ORDER");
    if (order) overrides.primaryTypeOrder = order.map((item) => item.toLowerCase()) as PrimaryType[];

    return resolveSearchConfig(overrides);
}
