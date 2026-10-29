import { describe, expect, test } from "bun:test";
import { DEFAULT_SEARCH_CONFIG as config } from "../../../server/utils/search/config";
import { normalizeText } from "../../../server/utils/search/normalize";
import {
    alignWords, compareCjk, exactness, grams, gramSize, levenshteinRatio, nameSimilarity, titleScore, wordsMatch
} from "../../../server/utils/search/similarity";

const n = (value: string) => normalizeText(value, config);

describe("tokenization per script", () => {
    test("Latin, Cyrillic and Greek are word tokens", () => {
        expect(n("Dark Side Moon").words).toEqual(["dark", "side", "moon"]);
        expect(n("Группа крови").words).toEqual(["группа", "крови"]);
        expect(n("Σωκράτης Μάλαμας").words).toEqual(["σωκρατησ", "μαλαμασ"]);
    });

    test("digits are word tokens", () => {
        expect(n("Apollo 440").words).toEqual(["apollo", "440"]);
    });

    test("CJK has no word tokens, only characters", () => {
        for (const value of ["宇多田ヒカル", "方大同", "방탄소년단", "ありがとう", "ประเทศไทย"]) {
            const t = n(value);
            expect(t.words).toEqual([]);
            expect(t.cjk.length).toBeGreaterThan(0);
        }
    });

    test("spaces inside CJK text do not matter", () => {
        expect(n("宇多田 ヒカル").cjk).toBe(n("宇多田ヒカル").cjk);
    });

    test("mixed scripts split into words and a CJK run", () => {
        const t = n("Utada 宇多田ヒカル");
        expect(t.words).toEqual(["utada"]);
        expect(t.cjk).toBe("宇多田ひかる");
    });

    test("n-grams: bigrams, unigrams for very short strings", () => {
        expect(grams("宇多田ひかる", 2)).toEqual(["宇多", "多田", "田ひ", "ひか", "かる"]);
        expect(grams("愛情", 1)).toEqual(["愛", "情"]);
        expect(gramSize("愛情", "愛情物語")).toBe(1);
        expect(gramSize("宇多田ひかる", "宇多田ヒカル")).toBe(2);
    });
});

describe("CJK similarity", () => {
    test("identical text scores 1, kana script does not matter", () => {
        expect(compareCjk(n("宇多田ヒカル").cjk, n("宇多田ひかる").cjk).dice).toBe(1);
    });

    test("an unrelated string scores near 0", () => {
        expect(compareCjk(n("宇多田ヒカル").cjk, n("椎名林檎").cjk).dice).toBe(0);
    });

    test("extra characters are counted", () => {
        const result = compareCjk(n("愛情").cjk, n("愛情物語").cjk);
        expect(result.coverage).toBe(1);
        expect(result.extraChars).toBe(2);
    });
});

describe("word matching with typo tolerance", () => {
    test("Levenshtein ratio", () => {
        expect(levenshteinRatio("kitten", "kitten")).toBe(1);
        expect(levenshteinRatio("zeppelin", "zepplin")).toBeCloseTo(0.875, 3);
        expect(levenshteinRatio("", "")).toBe(1);
    });

    test("a one-letter typo in a long word matches, in a short word it does not", () => {
        expect(wordsMatch("zeppelin", "zepplin", config)).toBeGreaterThanOrEqual(0.85);
        expect(wordsMatch("man", "men", config)).toBe(0);
        expect(wordsMatch("rumours", "rumors", config)).toBeGreaterThan(0);
    });

    test("numbers never fuzz", () => {
        expect(wordsMatch("2", "3", config)).toBe(0);
        expect(wordsMatch("1984", "1985", config)).toBe(0);
    });

    test("each candidate word is used once", () => {
        const alignment = alignWords(["red", "red"], ["red"], config);
        expect(alignment.matched).toBe(1);
        expect(alignment.missing).toEqual(["red"]);
    });
});

describe("words written apart or together", () => {
    test("two requested words make one candidate word, and the reverse", () => {
        const split = alignWords(["bottom", "less", "trench"], ["bottomless", "trench"], config);
        expect(split.matched).toBe(3);
        expect(split.missing).toEqual([]);
        expect(split.extra).toEqual([]);

        const joined = alignWords(["bottomless", "trench"], ["bottom", "less", "trench"], config);
        expect(joined.matched).toBe(2);
        expect(joined.extra).toEqual([]);
    });

    test("only what is left over is joined: words that match on their own stay as they are", () => {
        const alignment = alignWords(["dark", "side"], ["darkside", "dark", "side"], config);
        expect(alignment.missing).toEqual([]);
        expect(alignment.extra).toEqual(["darkside"]);
    });

    test("numbers are not joined", () => {
        expect(alignWords(["1", "2"], ["12"], config).matched).toBe(0);
    });
});

describe("typo credit", () => {
    test("the slope sets how much a near-miss word is worth: 1 is its similarity, 2 is far less", () => {
        const slope = (typoCreditSlope: number) => ({ ...config, typoCreditSlope });
        expect(wordsMatch("season", "seasons", slope(1))).toBeCloseTo(6 / 7, 5);
        expect(wordsMatch("season", "seasons", slope(2))).toBeCloseTo(5 / 7, 5);
        expect(wordsMatch("season", "season", slope(2))).toBe(1);
    });

    test("it never lets in a word the ratio rejects", () => {
        expect(wordsMatch("season", "reason", { ...config, typoCreditSlope: 2 })).toBe(0);
    });
});

describe("containment title score", () => {
    const score = (requested: string, candidate: string) => titleScore(n(requested), n(candidate), config);

    test("exact", () => {
        expect(score("Led Zeppelin", "Led Zeppelin").score).toBe(1);
    });

    test("extra distinctive words are penalized: 'Led Zeppelin' is not 'Led Zeppelin II'", () => {
        const result = score("Led Zeppelin", "Led Zeppelin II");
        expect(result.comparison.extraWords).toEqual(["2"]);
        expect(result.score).toBeCloseTo(config.extraTokenPenalty, 5);
        expect(score("Led Zeppelin", "Led Zeppelin x Led Zeppelin").score).toBeLessThan(result.score);
    });

    test("missing words lower coverage but are not 'extra'", () => {
        const result = score("Led Zeppelin II", "Led Zeppelin");
        expect(result.comparison.extraWords).toEqual([]);
        expect(result.comparison.coverage).toBeCloseTo(2 / 3, 5);
    });

    test("stopwords and edition descriptors do not count as extra", () => {
        expect(score("Dark Side of the Moon", "The Dark Side of the Moon (Remastered)").score).toBe(1);
    });

    test("typos are tolerated", () => {
        expect(score("Led Zepplin", "Led Zeppelin").score).toBeGreaterThan(0.9);
    });

    test("a request without a title is neutral", () => {
        expect(titleScore(n(""), n("Anything"), config).score).toBe(1);
    });

    test("CJK titles use Dice", () => {
        expect(score("初恋", "初恋").score).toBe(1);
        expect(score("初恋", "初恋物語").score).toBeLessThan(0.8);
        expect(score("First Love", "初恋").score).toBe(0);
    });
});

describe("name similarity", () => {
    const sim = (requested: string, candidate: string) => nameSimilarity(n(requested), n(candidate), config);

    test("order insensitive: sort names", () => {
        expect(sim("Maria Callas", "Callas, Maria")).toBeGreaterThanOrEqual(0.99);
    });

    test("a surname alone clears the artist floor, a different artist does not", () => {
        expect(sim("Callas", "Maria Callas")).toBeGreaterThanOrEqual(config.artistFloor);
        expect(sim("Led Zeppelin", "Pink Floyd")).toBeLessThan(config.artistFloor);
    });

    test("the article does not matter", () => {
        expect(sim("Beatles", "The Beatles")).toBe(1);
    });

    test("exactness of two titles", () => {
        expect(exactness(n("Abbey Road"), n("Abbey Road"))).toBe(1);
        expect(exactness(n("Abbey Road"), n("Abbey Roads"))).toBeLessThan(1);
    });
});
