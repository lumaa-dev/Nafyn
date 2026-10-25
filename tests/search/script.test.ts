import { describe, expect, test } from "bun:test";
import { hangulToRoman, kanaToRomaji, latinize, needsLatinForm, phoneticKey, romajiToKana, romajiToKanaVariants } from "../../server/utils/search/script";

describe("romaji -> kana", () => {
    test("Hepburn, Kunrei and Nihon-shiki spellings reach the same kana", () => {
        expect(romajiToKana("Hatachi no Koi")).toBe("はたちのこい");
        expect(romajiToKana("Hakucyumu")).toBe("はくちゅむ");
        expect(romajiToKana("Nihon Syonen No Natsu")).toBe("にほんしょねんのなつ");
        expect(romajiToKana("shi si chi ti tsu tu")).toBe("ししちちつつ");
    });

    test("ん, っ and long vowels", () => {
        expect(romajiToKana("konnichiwa")).toBe("こんにちわ");
        expect(romajiToKana("Kitte")).toBe("きって");
        expect(romajiToKana("matcha")).toBe("まっちゃ");
        expect(romajiToKana("Tōkyō")).toBe("とうきょう");
        expect(romajiToKana("shin'ya")).toBe("しんや");
    });

    test("anything that is not romaji is refused", () => {
        expect(romajiToKana("Stairway to Heaven")).toBeNull();
        expect(romajiToKana("")).toBeNull();
        expect(romajiToKana("...")).toBeNull();
    });

    test("a standalone wa / e / o is also read as the particle", () => {
        expect(romajiToKanaVariants("kimi wa kirei")).toEqual(["きみわきれい", "きみはきれい"]);
        expect(romajiToKanaVariants("kimi o")).toContain("きみを");
        expect(romajiToKanaVariants("Stairway")).toEqual([]);
    });
});

describe("kana -> romaji", () => {
    test("Hepburn", () => {
        expect(kanaToRomaji("ゆめうつつ")).toBe("yumeutsutsu");
        expect(kanaToRomaji("しゃっくり")).toBe("shakkuri");
        expect(kanaToRomaji("マッチャ")).toBe("matcha");
        expect(kanaToRomaji("ラーメン")).toBe("raamen");
        expect(kanaToRomaji("ファイト")).toBe("faito");
    });
});

describe("hangul -> Revised Romanization", () => {
    test("syllables, with the final consonant carried over into a following vowel", () => {
        expect(hangulToRoman("사랑해요")).toBe("saranghaeyo");
        expect(hangulToRoman("좋아")).toBe("joa");
        expect(hangulToRoman("읽어")).toBe("ilgeo");
        expect(hangulToRoman("한국어")).toBe("hangugeo");
    });

    test("text outside hangul is untouched", () => {
        expect(hangulToRoman("봄날 (Spring Day)")).toBe("bomnal (Spring Day)");
    });
});

describe("latinize", () => {
    test("Cyrillic, Greek and kana become Latin; kanji without a reading stay", () => {
        expect(latinize("Группа крови")).toBe("gruppa krovi");
        expect(latinize("Ελληνικά")).toBe("ellinika");
        expect(latinize("ヱンド・オブ・ア・ホリデヰ")).toBe("endo obu a horidei");
        expect(latinize("二十歳の恋")).toBe("二十歳 no 恋");
        expect(latinize("Already Latin")).toBe("Already Latin");
    });

    test("Han with no kana is read as Mandarin", () => {
        expect(latinize("月亮代表我的心")).toBe("yue liang dai biao wo de xin");
    });

    test("which texts need a Latin form", () => {
        expect(needsLatinForm("二十歳の恋")).toBe(true);
        expect(needsLatinForm("Кино")).toBe(true);
        expect(needsLatinForm("Bénabar")).toBe(false);
    });
});

describe("phonetic key", () => {
    test("two spellings of one sound share a key", () => {
        expect(phoneticKey("Hakucyumu")).toBe(phoneticKey("Hakuchuumu"));
        expect(phoneticKey("Hatachi no Koi")).toBe(phoneticKey("Hatachi No Koi"));
        expect(phoneticKey("Saranghaeyo")).toBe(phoneticKey("사랑해요"));
        expect(phoneticKey("Yume Utsutsu")).toBe(phoneticKey("ゆめうつつ"));
        expect(phoneticKey("Kino")).toBe(phoneticKey("Кино"));
    });

    test("different words do not", () => {
        expect(phoneticKey("Yume Utsutsu")).not.toBe(phoneticKey("Hatachi no Koi"));
    });
});
