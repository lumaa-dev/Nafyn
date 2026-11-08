import { describe, expect, test } from "bun:test";
import { isExcludedVersion, pickDiverse, rankByDuration, rankForTrack } from "../server/utils/soulseekRank";
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

    test("whole words, not pieces of them", () => {
        expect(nameMatchesAnyTitle("Numerology", ["Numero"])).toBe(false);
        expect(nameMatchesAnyTitle("01 - Numero", ["Numéro"])).toBe(true);
        expect(nameMatchesAnyTitle("Intro to Outro", ["Intro"])).toBe(true);
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
        // the same words in another order are the same Soulseek search: asked once
        expect(buildSearchQueries({ title: "Stairway to Heaven", artistName: "Led Zeppelin" })).toEqual([
            "Led Zeppelin Stairway to Heaven",
            "*ed Zeppelin Stairway to Heaven",
            "Led Zeppelin *tairway to Heaven",
            "Stairway to Heaven"
        ]);
    });

    test("the title without its decoration comes second", () => {
        const queries = buildSearchQueries({ title: "Get Lucky (feat. Pharrell Williams) - Radio Edit", artistName: "Daft Punk" });
        expect(queries[1]).toBe("Daft Punk Get Lucky");
        expect(queries).toContain("*aft Punk Get Lucky");
        expect(queries).toContain("Daft Punk *et Lucky");
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

describe("rankForTrack", () => {
    const target = { title: "Blinding Lights", artistName: "The Weeknd", duration: 200 };
    const file = (path: string, extra: Partial<{ user: string, length: number, slots: boolean, bitrate: number, queueLength: number, speed: number }> = {}) =>
        ({ user: "peer", file: path, length: 200, slots: true, bitrate: 320, ...extra });
    const order = (results: ReturnType<typeof file>[]) => rankForTrack(results, target).map((entry) => entry.result.file);

    test("other versions sharing the runtime are dropped unless asked for", () => {
        expect(order([file("Music\\The Weeknd - Blinding Lights (Instrumental).mp3"), file("Music\\The Weeknd - Blinding Lights.mp3")]))
            .toEqual(["Music\\The Weeknd - Blinding Lights.mp3"]);
        expect(isExcludedVersion("Blinding Lights (Instrumental)", { title: "Blinding Lights (Instrumental)" })).toBe(false);
        expect(isExcludedVersion("Blinding Lights - sped up", target)).toBe(true);
    });

    test("the right length first, then a plain take before an extended one, then the title in the filename", () => {
        expect(order([
            file("x/The Weeknd - Blinding Lights.mp3", { length: 260 }),
            file("x/The Weeknd - Blinding Lights (Extended).mp3"),
            file("The Weeknd - Blinding Lights/01.mp3"),
            file("x/01 - Blinding Lights.mp3")
        ])).toEqual([
            "x/01 - Blinding Lights.mp3",
            "The Weeknd - Blinding Lights/01.mp3",
            "x/The Weeknd - Blinding Lights (Extended).mp3",
            "x/The Weeknd - Blinding Lights.mp3"
        ]);
    });

    test("another version is never downloaded unless the request is for it: live, remix, acoustic, cover, demo...", () => {
        for (const bad of [
            "The Weeknd - Blinding Lights (Live).mp3",
            "The Weeknd - Blinding Lights (Live at Wembley).mp3",
            "The Weeknd - Blinding Lights - Remix.mp3",
            "The Weeknd - Blinding Lights (Acoustic).mp3",
            "The Weeknd - Blinding Lights (cover).mp3",
            "The Weeknd - Blinding Lights demo.mp3",
            "The Weeknd - Blinding Lights (Piano Version).mp3",
            "The Weeknd - Blinding Lights (Japanese ver.).mp3"
        ]) expect(order([file(bad)])).toEqual([]);
        // the studio file stays
        expect(order([file("The Weeknd - Blinding Lights.mp3"), file("The Weeknd - Blinding Lights (Live).mp3")])).toEqual(["The Weeknd - Blinding Lights.mp3"]);
    });

    test("...but is when it is: the title, the recording's disambiguation or the album says so", () => {
        const live = { ...target, title: "Blinding Lights (Live)" };
        expect(rankForTrack([file("The Weeknd - Blinding Lights (Live).mp3")], live)).toHaveLength(1);
        const viaNote = { ...target, disambiguation: "live, 2021: Super Bowl" };
        expect(rankForTrack([file("The Weeknd - Blinding Lights (Live at Super Bowl).mp3")], viaNote)).toHaveLength(1);
        const viaAlbum = { ...target, album: "Live at SoFi Stadium" };
        expect(rankForTrack([file("The Weeknd - Blinding Lights (Live).mp3")], viaAlbum)).toHaveLength(1);
        // a remix is still not live
        expect(rankForTrack([file("The Weeknd - Blinding Lights (Remix).mp3")], live)).toEqual([]);
    });

    test("the folder says it too: a live album, a studio album that merely has the word", () => {
        expect(order([file("The Weeknd/Live at Wembley/Blinding Lights.mp3")])).toEqual([]);
        expect(order([file("The Weeknd/MTV Unplugged/Blinding Lights.mp3")])).toEqual([]);
        expect(order([file("The Weeknd/Live Through This/Blinding Lights.mp3")])).toEqual(["The Weeknd/Live Through This/Blinding Lights.mp3"]);
    });

    test("an artist whose name holds a version word is not that version", () => {
        const live = { title: "Heart Attack", artistName: "Live", duration: 200 };
        expect(rankForTrack([file("Live/Heart Attack.mp3")], live)).toHaveLength(1);
    });

    test("another language than the one requested: dropped; English is what an unmarked title is", () => {
        const lifetime = { title: "Lifetime Showtime", artistName: "FUWAMOCO", duration: 200 };
        const names = (...paths: string[]) => rankForTrack(paths.map((path) => file(path)), lifetime).map((entry) => entry.result.file);
        expect(names("FUWAMOCO - Lifetime Showtime (Japanese Ver.).mp3")).toEqual([]);
        expect(names("FUWAMOCO - Lifetime Showtime (日本語ver).mp3")).toEqual([]);
        expect(names("FUWAMOCO/Lifetime Showtime (Korean Version)/01 Lifetime Showtime.mp3")).toEqual([]);
        expect(names("FUWAMOCO - Lifetime Showtime (English Ver.).mp3")).toHaveLength(1);
        expect(names("FUWAMOCO - Lifetime Showtime.mp3")).toHaveLength(1);

        // a Japanese version that was asked for is the one wanted, and then English is the other language
        const japanese = { ...lifetime, title: "Lifetime Showtime (Japanese ver.)" };
        const only = (path: string) => rankForTrack([file(path)], japanese).length;
        expect(only("FUWAMOCO - Lifetime Showtime (Japanese Ver.).mp3")).toBe(1);
        expect(only("FUWAMOCO - Lifetime Showtime (English Ver.).mp3")).toBe(0);
    });

    test("a file with no trace of the title in its path is another song", () => {
        const names = rankForTrack([
            file("The Weeknd/After Hours/04 Heartless.mp3"),
            file("The Weeknd/After Hours/09 Blinding Lights.mp3")
        ], target).map((entry) => entry.result.file);
        expect(names).toEqual(["The Weeknd/After Hours/09 Blinding Lights.mp3"]);
    });

    test("a short title shared by many songs needs the artist in the path", () => {
        const numero = { title: "Numéro", artistName: "Anyme023", duration: 150 };
        const names = rankForTrack([
            file("Various/Latin Hits/Numero.mp3", { length: 150 }),
            file("Random/Numero Uno.mp3", { length: 150 }),
            file("Anyme023/Numéro.mp3", { length: 150 })
        ], numero).map((entry) => entry.result.file);
        expect(names).toEqual(["Anyme023/Numéro.mp3"]);
    });

    test("a title written two ways is found by either: the bracket holds the other spelling", () => {
        const bts = { title: "작은 것들을 위한 시 (Boy With Luv)", artistName: "BTS", duration: 230 };
        expect(rankForTrack([file("BTS/Map of the Soul Persona/Boy With Luv.mp3", { length: 230 })], bts)).toHaveLength(1);
        expect(rankForTrack([file("BTS - 작은 것들을 위한 시.mp3", { length: 230 })], bts)).toHaveLength(1);
        expect(rankForTrack([file("BTS - Boy With Luv (Japanese ver.).mp3", { length: 230 })], bts)).toEqual([]);
        // and the soundtrack tag in a title is no part of the song's name
        const villains = { title: "Calling All Villains (Soundtrack)", artistName: "ZAMination", duration: 180 };
        expect(rankForTrack([file("ZAMination - Calling All Villains.mp3", { length: 180 })], villains)).toHaveLength(1);
    });

    test("a filename with words the title doesn't have comes after an exact one", () => {
        expect(order([
            file("a/The Weeknd - Blinding Lights Chromatics Mix.mp3"),
            file("a/The Weeknd - Blinding Lights.mp3")
        ])[0]).toBe("a/The Weeknd - Blinding Lights.mp3");
    });

    test("the artist in the path, then a peer with a free slot and a short queue", () => {
        expect(order([
            file("a/Blinding Lights.mp3", { user: "no-artist" }),
            file("The Weeknd/Blinding Lights.mp3", { user: "busy", slots: false }),
            file("The Weeknd/Blinding Lights.mp3", { user: "queued", queueLength: 50 }),
            file("The Weeknd/Blinding Lights.mp3", { user: "free" })
        ])).toHaveLength(4);
        const users = rankForTrack([
            file("a/Blinding Lights.mp3", { user: "no-artist" }),
            file("The Weeknd/Blinding Lights.mp3", { user: "busy", slots: false }),
            file("The Weeknd/Blinding Lights.mp3", { user: "queued", queueLength: 50 }),
            file("The Weeknd/Blinding Lights.mp3", { user: "free" })
        ], target).map((entry) => entry.result.user);
        expect(users).toEqual(["free", "queued", "busy", "no-artist"]);
    });

    test("quality only breaks ties, lossless counts as high", () => {
        const users = rankForTrack([
            file("The Weeknd/Blinding Lights.mp3", { user: "128", bitrate: 128 }),
            file("The Weeknd/Blinding Lights.flac", { user: "flac", bitrate: 0 })
        ], target).map((entry) => entry.result.user);
        expect(users).toEqual(["flac", "128"]);
    });

    test("strong = right length, plain take, title in the filename", () => {
        const ranked = rankForTrack([file("The Weeknd/Blinding Lights.mp3"), file("The Weeknd/Blinding Lights.mp3", { user: "far", length: 300 })], target);
        expect(ranked.map((entry) => entry.strong)).toEqual([true, false]);
    });
});

describe("pickDiverse", () => {
    test("at most two files from one peer before anybody else's", () => {
        const ranked = ["a", "a", "a", "b", "a", "c"].map((user, index) => ({ user, index }));
        expect(pickDiverse(ranked, 5).map((entry) => entry.index)).toEqual([0, 1, 3, 5, 2]);
    });
});
