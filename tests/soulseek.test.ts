import { describe, expect, test } from "bun:test";
import { rankByDuration } from "../server/utils/soulseekRank";
import { buildSearchQueries, dropLeadingChars, filenameVariants, foldDiacritics, matchKey, nameMatchesAnyTitle, soulseekQueryText } from "../server/utils/soulseekText";
import { sanitizePathSegment } from "../server/utils/pathSegment";

describe("foldDiacritics", () => {
    test("Latin accents go, every other script stays composed", () => {
        expect(foldDiacritics("Bénabar Dîner Mötley Crüe")).toBe("Benabar Diner Motley Crue");
        // NFD would have taken these apart into jamo / a base kana + U+3099
        expect(foldDiacritics("한국어")).toBe("한국어");
        expect(foldDiacritics("がぎぐ")).toBe("がぎぐ");
        expect(foldDiacritics("Кино")).toBe("Кино");
    });

    test("decomposed input comes back composed", () => {
        expect(foldDiacritics("한국어".normalize("NFD"))).toBe("한국어");
        expect(foldDiacritics("が".normalize("NFD"))).toBe("が");
    });
});

describe("soulseekQueryText", () => {
    test("keeps non-Latin text whole and cleans what a request cannot carry", () => {
        expect(soulseekQueryText("Lamp 二十歳の恋")).toBe("Lamp 二十歳の恋");
        expect(soulseekQueryText("  ＢＴＳ ​ 봄날 ")).toBe("BTS 봄날");
        expect(soulseekQueryText("Artist - Title")).toBe("Artist Title");
        expect(soulseekQueryText("-excluded word")).toBe("excluded word");
    });

    test("a lone surrogate never reaches the network", () => {
        const query = soulseekQueryText(`Artist \ud800 Title`);
        expect(query).toBe("Artist Title");
        expect(JSON.stringify(query)).not.toContain("\\ud800");
    });

    test("cut by characters, never inside one", () => {
        const long = soulseekQueryText("𠮷".repeat(500));
        expect(Array.from(long).length).toBe(200);
        expect(long.isWellFormed()).toBe(true);
    });
});

describe("dropLeadingChars", () => {
    test("does not split an astral character", () => {
        expect(dropLeadingChars("𠮷野家")).toBe("野家");
        expect("𠮷野家".substring(1).isWellFormed()).toBe(false);
    });
});

describe("matching a filename to a title", () => {
    test("native, composed or decomposed", () => {
        expect(nameMatchesAnyTitle("08 - 二十歳の恋", ["二十歳の恋"])).toBe(true);
        expect(nameMatchesAnyTitle("01 봄날".normalize("NFD"), ["봄날"])).toBe(true);
        expect(nameMatchesAnyTitle("Black Dog", ["Stairway to Heaven"])).toBe(false);
    });

    test("katakana and hiragana are the same", () => {
        expect(nameMatchesAnyTitle("ゆめうつつ", ["ユメウツツ"])).toBe(true);
    });

    test("a romanized file for a native title, and the reverse", () => {
        expect(nameMatchesAnyTitle("08 Hatachi no Koi", ["二十歳の恋", "Hatachi No Koi"])).toBe(true);
        expect(nameMatchesAnyTitle("08 Yume Utsutsu", ["ゆめうつつ"])).toBe(true);
        expect(nameMatchesAnyTitle("09 saranghaeyo", ["사랑해요"])).toBe(true);
        expect(nameMatchesAnyTitle("10 Kino", ["Кино"])).toBe(false); // too short for a phonetic match
        expect(nameMatchesAnyTitle("ゆめうつつ", ["Yume Utsutsu"])).toBe(true);
    });

    test("a filename a legacy client sent as UTF-8 bytes read as Latin-1", () => {
        const mojibake = Buffer.from("ゆめうつつ", "utf8").toString("latin1");
        expect(filenameVariants(mojibake)).toContain("ゆめうつつ");
        expect(nameMatchesAnyTitle(mojibake, ["ゆめうつつ"])).toBe(true);
    });

    test("an ordinary Latin name has one reading", () => {
        expect(filenameVariants("Stairway to Heaven")).toEqual(["Stairway to Heaven"]);
        expect(matchKey("Dîner (Live)")).toBe("diner live");
    });
});

describe("buildSearchQueries", () => {
    test("a Japanese track is also searched under its Latin release's title", () => {
        const queries = buildSearchQueries({ title: "二十歳の恋", altTitles: ["Hatachi No Koi"], artistName: "Lamp" });
        expect(queries[0]).toBe("Lamp 二十歳の恋");
        expect(queries).toContain("Lamp Hatachi No Koi");
        // no half-romanized "二十歳 no 恋"
        expect(queries.some((query) => query.includes("二十歳 no"))).toBe(false);
    });

    test("a Korean artist is searched under its Latin name too", () => {
        const queries = buildSearchQueries({ title: "사랑해요", artistName: "아이유", artistAliases: ["IU"] });
        expect(queries).toContain("IU 사랑해요");
        expect(queries).toContain("IU saranghaeyo");
        expect(queries.every((query) => query.isWellFormed())).toBe(true);
    });

    test("a Latin track keeps its original queries", () => {
        expect(buildSearchQueries({ title: "Stairway to Heaven", artistName: "Led Zeppelin" })).toEqual([
            "Led Zeppelin Stairway to Heaven",
            "Stairway to Heaven Led Zeppelin",
            "*ed Zeppelin Stairway to Heaven",
            "Stairway to Heaven *ed Zeppelin",
            "Stairway to Heaven"
        ]);
    });

    test("at most eight", () => {
        const queries = buildSearchQueries({ title: "二十歳の恋", altTitles: ["A One", "B Two", "C Three"], artistName: "Lamp", artistAliases: ["ランプ", "Lamp JP"] });
        expect(queries.length).toBeLessThanOrEqual(8);
    });
});

describe("sanitizePathSegment", () => {
    test("a long CJK title fits the 255-byte limit of a filename", () => {
        const title = "あ".repeat(120);
        const segment = sanitizePathSegment(title);
        expect(Buffer.byteLength(segment, "utf8")).toBeLessThanOrEqual(200);
        expect(Buffer.byteLength(`${segment} (99).flac`, "utf8")).toBeLessThanOrEqual(255);
    });

    test("never cuts an astral character and drops what is not valid UTF-8", () => {
        const segment = sanitizePathSegment(`${"𠮷".repeat(80)}\ud800\ufffd`);
        expect(segment.isWellFormed()).toBe(true);
        expect(segment).not.toContain("�");
    });

    test("composed, no separators, no leading or trailing dots", () => {
        expect(sanitizePathSegment("한국어".normalize("NFD"))).toBe("한국어");
        expect(sanitizePathSegment("../a/b: c?...")).toBe("ab c");
        expect(sanitizePathSegment("..")).toBe("Unknown");
    });
});

const lengths = (results: Array<{ length?: number }>) => results.map((result) => result.length);

describe("rankByDuration", () => {
    test("nearest to furthest from the MusicBrainz length", () => {
        const ranked = rankByDuration([{ length: 250 }, { length: 181 }, { length: 100 }, { length: 179 }, { length: 180 }], 180);
        expect(lengths(ranked)).toEqual([180, 181, 179, 250, 100]);
    });

    test("a file of unknown length comes after the ones within tolerance and before the ones far off", () => {
        const ranked = rankByDuration([{ length: 300 }, {}, { length: 183 }, { length: 0 }, { length: 178 }], 180);
        expect(lengths(ranked)).toEqual([178, 183, undefined, 0, 300]);
    });

    test("same distance: higher bitrate, then faster peer, then the order they arrived in", () => {
        const ranked = rankByDuration([
            { length: 179, bitrate: 128, speed: 9 },
            { length: 181, bitrate: 320, speed: 1 },
            { length: 181, bitrate: 320, speed: 5 },
            { length: 181, bitrate: 320, speed: 5, id: "later" }
        ] as Array<{ length: number, bitrate: number, speed: number, id?: string }>, 180);
        expect(ranked.map((result) => result.bitrate)).toEqual([320, 320, 320, 128]);
        expect(ranked.map((result) => result.speed)).toEqual([5, 5, 1, 9]);
        expect(ranked[1]!.id).toBe("later");
    });

    test("no MusicBrainz length: quality order, nothing dropped", () => {
        const ranked = rankByDuration([{ length: 10, bitrate: 128 }, { length: 999, bitrate: 320 }], 0);
        expect(lengths(ranked)).toEqual([999, 10]);
    });

    test("does not mutate its input", () => {
        const input = [{ length: 300 }, { length: 180 }];
        rankByDuration(input, 180);
        expect(lengths(input)).toEqual([300, 180]);
    });
});
