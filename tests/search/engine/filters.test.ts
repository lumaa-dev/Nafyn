import { describe, expect, test } from "bun:test";
import { searchAlbums, searchTracks } from "../../../server/utils/search/engine";
import { hasCompilationKeyword } from "../../../server/utils/search/filters";
import { DEFAULT_SEARCH_CONFIG } from "../../../server/utils/search/config";
import { album, stubDeps, type World } from "./stub";

const find = async (world: World, input: Parameters<typeof searchAlbums>[0], serverFilters = true) => {
    const everything = world.groups.flatMap((g) => [g.id, ...(g.releases ?? []).map((r) => r.id)]);
    const deps = stubDeps({ ...world, serverFilters }, { covered: everything });
    return (await searchAlbums(input, deps)).results.map((r) => r.id);
};

// the same cases with MusicBrainz' own filtering switched off: the engine must not trust the server for these
for (const serverFilters of [true, false]) {
    describe(`hard filters (server filtering ${serverFilters ? "on" : "off"})`, () => {
        test("a bootleg-only release-group is dropped", async () => {
            const world = { groups: [album("bootleg", "Live Tape", "Band", { releases: [{ id: "b1", status: "Bootleg" }] })] };
            expect(await find(world, { title: "Live Tape", artist: "Band" }, serverFilters)).toEqual([]);
        });

        test("promotion and pseudo-releases are dropped, an official sibling keeps the group", async () => {
            const promo = { groups: [album("p", "Single", "Band", { releases: [{ id: "p1", status: "Promotion" }, { id: "p2", status: "Pseudo-Release" }] })] };
            expect(await find(promo, { title: "Single", artist: "Band" }, serverFilters)).toEqual([]);
            const mixed = { groups: [album("m", "Single", "Band", { releases: [{ id: "m1", status: "Promotion" }, { id: "m2", date: "2001" }] })] };
            expect(await find(mixed, { title: "Single", artist: "Band" }, serverFilters)).toEqual(["m"]);
        });

        test("a work without an official Digital Media release is dropped", async () => {
            const world = { groups: [album("cd", "Vinyl Only", "Band", { releases: [{ id: "c1", format: "CD" }, { id: "c2", format: '12" Vinyl' }] })] };
            expect(await find(world, { title: "Vinyl Only", artist: "Band" }, serverFilters)).toEqual([]);
        });

        test("a CD plus a digital release is kept", async () => {
            const world = { groups: [album("both", "Both", "Band", { releases: [{ id: "c1", format: "CD" }, { id: "d1", date: "2010" }] })] };
            expect(await find(world, { title: "Both", artist: "Band" }, serverFilters)).toEqual(["both"]);
        });

        test("compilation release-groups are dropped", async () => {
            const world = { groups: [album("comp", "Hits Of The Year", "Band", { secondary: ["Compilation"] })] };
            expect(await find(world, { title: "Hits Of The Year", artist: "Band" }, serverFilters)).toEqual([]);
        });

        test("demos, interviews and spoken word are dropped, live and remix kept", async () => {
            const world = {
                groups: [
                    album("demo", "Rough", "Band", { secondary: ["Demo"] }),
                    album("live", "Rough Live", "Band", { secondary: ["Live"] }),
                    album("remix", "Rough Remixed", "Band", { secondary: ["Remix"] })
                ]
            };
            const found = await find(world, { artist: "Band" }, serverFilters);
            expect(found).not.toContain("demo");
            expect(found).toContain("live");
            expect(found).toContain("remix");
        });

        test("Deluxe and Remaster editions are excluded unless the query names them", async () => {
            const world = {
                groups: [
                    album("deluxe", "Record (Deluxe Edition)", "Band"),
                    album("remaster", "Record (Remastered)", "Band"),
                    album("plain", "Record", "Band", { releases: [{ id: "r1", date: "1999" }, { id: "r2", title: "Record (Deluxe)", date: "1998" }, { id: "r3", disambiguation: "2011 remaster", date: "1997" }] })
                ]
            };
            const found = await find(world, { title: "Record", artist: "Band" }, serverFilters);
            expect(found).toEqual(["plain"]);
            // …and the plain group is judged on its plain release, not on the earlier deluxe/remaster ones
            const deps = stubDeps({ ...world, serverFilters }, { covered: ["plain", "r1"] });
            const [hit] = (await searchAlbums({ title: "Record", artist: "Band" }, deps)).results;
            expect(hit?.releaseId).toBe("r1");

            // asked for: the edition qualifies (the three groups are one work, so dedupe keeps the best-ranked - the
            // one whose release IS the deluxe edition)
            const asked = stubDeps({ ...world, serverFilters }, { covered: ["deluxe", "remaster", "plain", "deluxe-r1", "r1", "r2", "r3"] });
            const deluxe = (await searchAlbums({ title: "Record Deluxe Edition", artist: "Band" }, asked)).results;
            expect(deluxe).toHaveLength(1);
            expect(deluxe[0]!.releaseTitle).toMatch(/deluxe/i);
            const remaster = (await searchAlbums({ title: "Record Remastered", artist: "Band" }, asked)).results;
            expect(remaster).toHaveLength(1);
            expect(["r3", "remaster-r1"]).toContain(remaster[0]!.releaseId!);
        });
    });
}

describe("'Best of' title heuristic", () => {
    test("multilingual keywords", () => {
        for (const title of [
            "Greatest Hits", "The Very Best of Queen", "Best Of", "Essentials", "Anthology", "The Collection",
            "Le Meilleur de Cabrel", "Лучшее", "Избранное", "ベスト", "ベスト・オブ・ミスチル", "精选", "BEST OF 2010", "Grandes Éxitos", "O Melhor de Caetano"
        ]) expect(hasCompilationKeyword(title, DEFAULT_SEARCH_CONFIG)).toBe(true);
        for (const title of ["Abbey Road", "Bestial", "Nevermind", "Hits and Misses", "Первый альбом"]) {
            expect(hasCompilationKeyword(title, DEFAULT_SEARCH_CONFIG)).toBe(false);
        }
    });

    test("an album titled like a greatest-hits record is dropped even without the Compilation type", async () => {
        const world = { groups: [album("gh", "Greatest Hits", "Band", { secondary: [] })] };
        expect(await find(world, { artist: "Band" })).toEqual([]);
    });

    test("a keyword in the query lifts the heuristic, not the Compilation type", async () => {
        const world = {
            groups: [
                album("typed", "Greatest Hits", "Band", { secondary: ["Compilation"] }),
                album("untyped", "Greatest Hits II", "Band", { secondary: [] })
            ]
        };
        expect(await find(world, { title: "Greatest Hits II", artist: "Band" })).toEqual(["untyped"]);
    });

    test("the keyword list is configurable", async () => {
        const world = { groups: [album("x", "Sampler Platter", "Band")] };
        const deps = stubDeps(world, { covered: ["x"], config: { compilationKeywords: [...DEFAULT_SEARCH_CONFIG.compilationKeywords, "sampler"] } });
        expect((await searchAlbums({ artist: "Band" }, deps)).results).toEqual([]);
    });
});

describe("track filters: a recording counts only through releases that pass", () => {
    const world: World = {
        groups: [
            album("studio", "Studio Album", "Band", { releases: [{ id: "s1", date: "2001" }] }),
            album("comp", "Greatest Hits", "Band", { secondary: ["Compilation"], releases: [{ id: "c1" }] }),
            album("cdonly", "CD Album", "Band", { releases: [{ id: "cd1", format: "CD" }] }),
            album("boot", "Bootleg Night", "Band", { releases: [{ id: "bo1", status: "Bootleg" }] })
        ],
        recordings: [
            { id: "on-album-and-comp", title: "Song", artist: "Band", date: "2001", on: [{ group: "comp", release: { id: "c1" } }, { group: "studio", release: { id: "s1" } }] },
            { id: "comp-only", title: "Song", artist: "Band", length: 111000, on: [{ group: "comp", release: { id: "c1" } }] },
            { id: "cd-only", title: "Song", artist: "Band", length: 222000, on: [{ group: "cdonly", release: { id: "cd1", format: "CD" } }] },
            { id: "boot-only", title: "Song", artist: "Band", length: 333000, on: [{ group: "boot", release: { id: "bo1", status: "Bootleg" } }] }
        ]
    };

    test("compilation-only, CD-only and bootleg-only recordings are dropped", async () => {
        const deps = stubDeps(world, { covered: ["s1", "studio"] });
        const results = (await searchTracks({ title: "Song", artist: "Band" }, deps)).results;
        expect(results.map((r) => r.id)).toEqual(["on-album-and-comp"]);
    });

    test("the surviving recording is judged on its qualifying release, not the compilation", async () => {
        const deps = stubDeps(world, { covered: ["s1", "studio"] });
        const [hit] = (await searchTracks({ title: "Song", artist: "Band" }, deps)).results;
        expect(hit?.releaseId).toBe("s1");
        expect(hit?.albumId).toBe("studio");
    });
});

describe("dedupe", () => {
    test("the same work across regions/editions keeps only the best-ranked one", async () => {
        const world = {
            groups: [
                album("eu", "Record", "Band", { releases: [{ id: "eu1", date: "2005" }] }),
                album("jp", "Record", "Band", { releases: [{ id: "jp1", date: "2004" }] }),
                album("other", "Another", "Band")
            ]
        };
        const found = await find(world, { artist: "Band" });
        expect(found.filter((id) => id === "eu" || id === "jp")).toHaveLength(1);
        expect(found).toContain("other");
    });
});
