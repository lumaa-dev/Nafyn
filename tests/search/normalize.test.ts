import { describe, expect, test } from "bun:test";
import { DEFAULT_SEARCH_CONFIG as config } from "../../server/utils/search/config";
import { cleanText, foldForKeywords, normalizeText } from "../../server/utils/search/normalize";

const text = (value: string) => normalizeText(value, config).text;

describe("accent folding", () => {
    test("Latin accents fold", () => {
        expect(text("Mötley Crüe")).toBe(text("Motley Crue"));
        expect(text("Beyoncé")).toBe("beyonce");
        expect(text("Sigur Rós")).toBe("sigur ros");
    });

    test("letters NFD cannot split fold through a table", () => {
        expect(text("Björk Ødegård")).toBe("bjork odegard");
        expect(text("Straße")).toBe("strasse");
    });

    test("Cyrillic marks fold: Ё == Е, Й == И", () => {
        expect(text("Ёлка")).toBe(text("Елка"));
        expect(text("Ёлка")).toBe("елка");
        expect(text("Майка")).toBe(text("Маика"));
    });

    test("Greek tonos and final sigma fold", () => {
        expect(text("Σωκράτης")).toBe(text("Σωκρατης"));
        expect(text("ΟΔΥΣΣΕΑΣ")).toBe(text("οδυσσεασ"));
    });

    test("kana and hangul are never decomposed (dakuten survives)", () => {
        expect(text("が")).not.toBe(text("か"));
        expect(text("한국어")).toBe("한국어");
        expect(normalizeText("が", config).cjk).toBe("が");
    });
});

describe("full-width and compatibility forms", () => {
    test("full-width Latin and digits fold to ASCII", () => {
        expect(text("Ｌｅｄ　Ｚｅｐｐｅｌｉｎ")).toBe("led zeppelin");
        expect(text("ＡＢＣ１２３")).toBe("abc123");
    });

    test("half-width katakana folds, and katakana == hiragana for comparison", () => {
        expect(text("ﾋｶﾙ")).toBe(text("ヒカル"));
        expect(text("ヒカル")).toBe(text("ひかる"));
    });

    test("ligatures and compatibility characters", () => {
        expect(text("ﬁnal")).toBe("final");
        expect(text("№1")).toBe(text("No1"));
    });
});

describe("CJK is not transliterated", () => {
    test("kanji/kana/hanzi/hangul stay as characters", () => {
        const n = normalizeText("宇多田ヒカル", config);
        expect(n.words).toEqual([]);
        expect(n.cjk).toBe("宇多田ひかる");
        expect(normalizeText("精选", config).cjk).toBe("精选");
        expect(normalizeText("방탄소년단", config).cjk).toBe("방탄소년단");
    });

    test("the original text is kept for display", () => {
        expect(normalizeText("宇多田ヒカル", config).original).toBe("宇多田ヒカル");
    });

    test("Han is never folded onto kana or Latin", () => {
        expect(text("宇多田")).not.toBe(text("utada"));
    });
});

describe("punctuation", () => {
    test("apostrophes inside words are deleted, both straight and curly", () => {
        expect(text("Man's World")).toBe("mans world");
        expect(text("Man’s World")).toBe("mans world");
        expect(text("Rock 'n' Roll")).toBe("rock n roll");
    });

    test("separators become spaces", () => {
        expect(text("AC_DC")).toBe("ac dc");
        expect(text("a/b (c) [d] + e, f - g_h")).toBe("a b c d e f g h");
    });

    test("dots between single letters join them", () => {
        expect(text("R.E.M.")).toBe(text("REM"));
        expect(text("Mr. Brightside")).toBe("mr brightside");
    });

    test("& and 'and' agree", () => {
        expect(normalizeText("Simon & Garfunkel", config).distinctive).toEqual(normalizeText("Simon and Garfunkel", config).distinctive);
    });

    test("roman numerals match digits", () => {
        expect(text("Led Zeppelin II")).toBe(text("Led Zeppelin 2"));
        expect(text("Rocky IV")).toBe("rocky 4");
    });
});

describe("junk", () => {
    test("feat. credits", () => {
        for (const raw of ["Song (feat. Someone)", "Song feat. Someone", "Song ft. Someone", "Song [featuring Someone Else]", "Song (Ft Someone)"]) {
            expect(text(raw)).toBe("song");
        }
    });

    test("a feat. credit in the middle of 'Artist - Title' does not eat the title", () => {
        expect(text("Beyoncé feat. Jay-Z - Crazy in Love")).toBe("beyonce crazy in love");
    });

    test("leading tags, extensions, track numbers", () => {
        expect(text("[Explicit] Song Title")).toBe("song title");
        expect(text("Song Title.mp3")).toBe("song title");
        expect(text("Song Title.FLAC")).toBe("song title");
        expect(text("01 - Song Title")).toBe("song title");
        expect(text("1. Song Title")).toBe("song title");
        expect(text("07_Song Title")).toBe("song title");
    });

    test("numbers that belong to the title are kept", () => {
        expect(text("7 Rings")).toBe("7 rings");
        expect(text("1999")).toBe("1999");
        expect(text("(500) Days of Summer")).toBe("500 days of summer");
    });

    test("YouTube noise", () => {
        for (const raw of ["Song (Official Video)", "Song [Official Music Video]", "Song - Official Audio", "Song (Lyrics)", "Song (HD)", "Song | Official Video", "Song (Official Lyric Video) [4K]"]) {
            expect(text(raw)).toBe("song");
        }
        expect(text("Video Killed the Radio Star")).toBe(text("Video Killed the Radio Star"));
        expect(normalizeText("Video Killed the Radio Star", config).words).toContain("video");
    });

    test("edition and version descriptors are stripped", () => {
        for (const raw of [
            "Album (Deluxe)", "Album (Deluxe Edition)", "Album [Super Deluxe Edition]", "Album (Remastered)", "Album (Remastered 2011)",
            "Album (2011 Remaster)", "Album - Remastered 2009", "Album - 2011 Remaster", "Album (Expanded Edition)", "Album (Bonus Track Version)",
            "Album (20th Anniversary Edition)", "Album (Reissue)", "Album (Explicit)", "Album (Clean Version)", "Album Deluxe",
            "Album (Special Edition)", "Album (Collector's Edition)", "Album (Digitally Remastered)"
        ]) {
            expect(text(raw)).toBe("album");
        }
    });

    test("markers naming a different recording are kept", () => {
        for (const marker of ["Kygo Remix", "Live at Wembley", "Acoustic", "Radio Edit", "Instrumental", "Taylor's Version"]) {
            expect(text(`Song (${marker})`)).not.toBe("song");
        }
        expect(text("Song (Kygo Remix)")).toContain("kygo");
        expect(text("Song (Live at Wembley)")).toContain("wembley");
        expect(text("Song feat. Bob (Kygo Remix)")).toBe(text("Song (Kygo Remix)"));
    });

    test("a title that merely contains an edition-like word is left alone", () => {
        expect(text("Special")).toBe("special");
        expect(text("Clean Bandit")).toBe("clean bandit");
        expect(text("Original Pirate Material")).toBe("original pirate material");
        expect(text("Song (2012)")).toBe("song 2012");
    });
});

describe("stopwords", () => {
    test("ignored for matching only, in every configured language", () => {
        const d = (value: string) => normalizeText(value, config).distinctive;
        expect(d("The Dark Side of the Moon")).toEqual(["dark", "side", "moon"]);
        expect(d("Le Petit Prince")).toEqual(["petit", "prince"]);
        expect(d("Der Mond ist aufgegangen")).toEqual(["mond", "aufgegangen"]);
        expect(d("El amor de la vida")).toEqual(["amor", "vida"]);
        expect(d("Il mondo di Pinocchio")).toEqual(["mondo", "pinocchio"]);
        expect(d("O amor e a vida")).toEqual(["amor", "vida"]);
        // й folds onto и (comparison only), on both sides
        expect(d("Война и мир")).toEqual(["воина", "мир"]);
    });

    test("the full string still carries them", () => {
        expect(normalizeText("The Beatles", config).text).toBe("the beatles");
    });

    test("a title made only of stopwords keeps its words", () => {
        expect(normalizeText("The The", config).distinctive).toEqual(["the", "the"]);
    });

    test("languages are configurable", () => {
        const onlyFrench = { ...config, stopwordLanguages: ["fr"] };
        expect(normalizeText("The Dark Side", onlyFrench).distinctive).toEqual(["the", "dark", "side"]);
    });
});

describe("helpers", () => {
    test("cleanText keeps case-folded readable text for the MusicBrainz query", () => {
        expect(cleanText("Mötley Crüe (feat. X)")).toBe("motley crue");
        expect(cleanText("Группа крови")).toBe("группа крови");
    });

    test("foldForKeywords keeps edition words so they can be detected", () => {
        expect(foldForKeywords("Album (Deluxe Edition)")).toBe("album deluxe edition");
    });
});
