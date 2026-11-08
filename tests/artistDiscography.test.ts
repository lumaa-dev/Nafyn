import { describe, expect, test } from "bun:test";
import { DEFAULT_SEARCH_CONFIG } from "../server/utils/search/config";
import { compareNewestFirst, pickEditions, releaseCategory, type GroupRef } from "../server/utils/artistDiscography";
import type { RawRelease } from "../server/utils/search/types";

describe("releaseCategory", () => {
    test("a secondary type says more than the primary one", () => {
        expect(releaseCategory("Album", [])).toBe("album");
        expect(releaseCategory("Album", ["Live"])).toBe("live");
        expect(releaseCategory("Album", ["Compilation"])).toBe("compilation");
        expect(releaseCategory("Album", ["Compilation", "Live"])).toBe("live");
        expect(releaseCategory("Album", ["Remix"])).toBe("remix");
        expect(releaseCategory("Album", ["Soundtrack"])).toBe("soundtrack");
        expect(releaseCategory("EP", [])).toBe("ep");
        expect(releaseCategory("Single", [])).toBe("single");
        expect(releaseCategory("Broadcast", [])).toBe("other");
        expect(releaseCategory("Album", ["Demo"])).toBe("other");
        expect(releaseCategory(null, undefined)).toBe("other");
    });
});

const release = (id: string, group: string, title: string, extra: Partial<RawRelease> = {}): RawRelease => ({
    id, title, status: "Official", date: "2010-01-01", "release-group": { id: group, title }, ...extra
});

const groups = new Map<string, GroupRef>([
    ["pinkerton", { id: "pinkerton", title: "Pinkerton", category: "album" }],
    ["blue", { id: "blue", title: "Weezer", category: "album" }],
    ["live", { id: "live", title: "Live at the Roxy", category: "live" }],
    ["dlx-group", { id: "dlx-group", title: "Raditude (Deluxe Edition)", category: "album" }],
    ["single", { id: "single", title: "Buddy Holly", category: "single" }]
]);

describe("pickEditions", () => {
    test("the Deluxe edition inside an album's release-group becomes its own entry", () => {
        const picks = pickEditions([release("r1", "pinkerton", "Pinkerton (Deluxe Edition)")], groups, DEFAULT_SEARCH_CONFIG);
        expect(picks).toHaveLength(1);
        expect(picks[0]).toMatchObject({ groupId: "pinkerton", edition: "deluxe", title: "Pinkerton (Deluxe Edition)" });
    });

    test("a remaster is listed too, named by its disambiguation when the title does not say", () => {
        const picks = pickEditions([release("r1", "blue", "Weezer", { disambiguation: "2004 remastered" })], groups, DEFAULT_SEARCH_CONFIG);
        expect(picks[0]).toMatchObject({ edition: "remaster", title: "Weezer (2004 remastered)" });
    });

    test("not for a live album, a single, a group that is itself an edition, or an unofficial release", () => {
        const picks = pickEditions([
            release("a", "live", "Live at the Roxy (Deluxe)"),
            release("b", "single", "Buddy Holly (Deluxe)"),
            release("c", "dlx-group", "Raditude (Deluxe Edition)"),
            release("d", "pinkerton", "Pinkerton (Deluxe Edition)", { status: "Bootleg" }),
            release("e", "unknown-group", "Something (Deluxe)")
        ], groups, DEFAULT_SEARCH_CONFIG);
        expect(picks).toEqual([]);
    });

    test("one per group and kind: the earliest, or the earliest with a cover", () => {
        const releases = [
            release("late", "pinkerton", "Pinkerton (Deluxe Edition)", { date: "2012" }),
            release("early", "pinkerton", "Pinkerton (Deluxe Edition)", { date: "2010" }),
            release("remastered", "pinkerton", "Pinkerton (Remastered)", { date: "2015" })
        ];
        const plain = pickEditions(releases, groups, DEFAULT_SEARCH_CONFIG);
        expect(plain.map((pick) => pick.release.id).sort()).toEqual(["early", "remastered"]);
        const covered = pickEditions(releases, groups, DEFAULT_SEARCH_CONFIG, (candidate) => candidate.id !== "early");
        expect(covered.map((pick) => pick.release.id).sort()).toEqual(["late", "remastered"]);
    });
});

describe("compareNewestFirst", () => {
    test("newest first, undated last, the standard edition before an edition of the same day", () => {
        const list = [
            { id: "undated", date: null, edition: false },
            { id: "old", date: new Date("1996-09-24"), edition: false },
            { id: "deluxe", date: new Date("2010-11-02"), edition: true },
            { id: "standard", date: new Date("2010-11-02"), edition: false }
        ];
        expect(list.sort(compareNewestFirst).map((entry) => entry.id)).toEqual(["standard", "deluxe", "old", "undated"]);
    });
});
