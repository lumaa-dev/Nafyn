import { describe, expect, test } from "bun:test";
import { differentVersion, languagesOf, versionMarkers } from "../server/utils/versionMarkers";
import { judgeTags } from "../server/utils/tagEvidence";

describe("versionMarkers", () => {
    test("finds the version a text names, in several scripts", () => {
        expect([...versionMarkers("12:51 (Live at Madison Square Garden)")]).toEqual(["live"]);
        expect([...versionMarkers("Song - Acoustic Version")]).toEqual(["acoustic"]);
        expect([...versionMarkers("Song (ライブ)")]).toEqual(["live"]);
        expect([...versionMarkers("Song [Instrumental]")]).toEqual(["instrumental"]);
        expect(languagesOf(versionMarkers("Boy With Luv (Japanese ver.)"))).toEqual(["lang:japanese"]);
        expect(languagesOf(versionMarkers("봄날 (일본어)"))).toEqual(["lang:japanese"]);
        expect([...versionMarkers("Alive Again")]).toEqual([]);
        expect([...versionMarkers("Song (2011 Remaster)")]).toEqual([]);
    });
});

describe("differentVersion", () => {
    test("a marker on one side only is another version", () => {
        expect(differentVersion("12:51 (Live)", "12:51")).toBe(true);
        expect(differentVersion("12:51", "12:51 (Live)")).toBe(true);
        expect(differentVersion("12:51 (Live at the Roxy)", "12:51 (Live)")).toBe(false);
        expect(differentVersion("12:51", "12:51")).toBe(false);
        expect(differentVersion("12:51 (Remastered)", "12:51")).toBe(false);
    });

    test("languages", () => {
        expect(differentVersion("Lifetime Showtime (Japanese ver.)", "Lifetime Showtime")).toBe(true);
        expect(differentVersion("Lifetime Showtime (English ver.)", "Lifetime Showtime")).toBe(false);
        expect(differentVersion("Lifetime Showtime", "Lifetime Showtime (Japanese ver.)")).toBe(false);
        expect(differentVersion("Lifetime Showtime (English ver.)", "Lifetime Showtime (Japanese ver.)")).toBe(true);
    });
});

describe("judgeTags", () => {
    const target = { title: "Numéro", artistName: "Anyme023", artistAliases: [] as string[] };

    test("a file with no tags is neither vouched for nor contradicted", () => {
        expect(judgeTags({}, target).conflict).toBeNull();
        expect(judgeTags({ title: "", artist: "  " }, target).conflict).toBeNull();
    });

    test("the right title and artist", () => {
        expect(judgeTags({ title: "Numéro", artist: "Anyme023" }, target).conflict).toBeNull();
        expect(judgeTags({ title: "Numero (feat. Someone)", artist: "Anyme023, Someone" }, target).conflict).toBeNull();
    });

    test("another artist's song of that name, another song by the artist", () => {
        expect(judgeTags({ title: "Numéro", artist: "Some Other Band" }, target).conflict).toBe("artist");
        expect(judgeTags({ title: "Intro", artist: "Anyme023" }, target).conflict).toBe("title");
    });

    test("the right words in the wrong version", () => {
        expect(judgeTags({ title: "Numéro (Live)", artist: "Anyme023" }, target).conflict).toBe("version");
        expect(judgeTags({ title: "Numéro (Live)", artist: "Anyme023" }, { ...target, disambiguation: "live, 2020" }).conflict).toBeNull();
    });

    test("a tag in another script says nothing: 방탄소년단 may be BTS", () => {
        const bts = { title: "작은 것들을 위한 시 (Boy With Luv)", artistName: "BTS", artistAliases: [] as string[] };
        expect(judgeTags({ title: "Boy With Luv (feat. Halsey)", artist: "방탄소년단" }, bts).conflict).toBeNull();
        expect(judgeTags({ title: "Boy With Luv (Japanese ver.)", artist: "BTS" }, bts).conflict).toBe("version");
        expect(judgeTags({ title: "Dynamite", artist: "BTS" }, bts).conflict).toBe("title");
    });
});
