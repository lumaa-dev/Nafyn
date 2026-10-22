import { describe, expect, test } from "bun:test";
import { searchAlbums, searchTracks } from "../../server/utils/search/engine";
import { album, artist, stubDeps } from "./stub";

const ids = async (world: Parameters<typeof stubDeps>[0], input: Parameters<typeof searchAlbums>[0]) =>
    (await searchAlbums(input, stubDeps(world, { covered: world.groups.flatMap((g) => [g.id, `${g.id}-r1`]) }))).results.map((r) => r.id);

const zeppelin = artist("Led Zeppelin");
const catalog = {
    groups: [
        album("debut", "Led Zeppelin", zeppelin),
        album("two", "Led Zeppelin II", zeppelin),
        album("four", "Led Zeppelin IV", zeppelin),
        album("tribute", "Led Zeppelin x Led Zeppelin", zeppelin)
    ]
};

describe("different-album guard", () => {
    test("a self-titled debut does not return its numbered sequels", async () => {
        expect(await ids(catalog, { title: "Led Zeppelin", artist: "Led Zeppelin" })).toEqual(["debut"]);
    });

    test("the artist is recognizable inside the title when none was given", async () => {
        expect(await ids(catalog, { title: "Led Zeppelin" })).toEqual(["debut"]);
    });

    test("the sequel is found when asked for, in digits or roman numerals", async () => {
        expect(await ids(catalog, { title: "Led Zeppelin II", artist: "Led Zeppelin" })).toContain("two");
        expect(await ids(catalog, { title: "Led Zeppelin 2", artist: "Led Zeppelin" })).toContain("two");
        // the debut lacks a word the request had - allowed (never rejected for what is *missing*), but ranked below
        expect((await ids(catalog, { title: "Led Zeppelin II", artist: "Led Zeppelin" }))[0]).toBe("two");
    });

    test("only EXTRA words reject: a candidate missing words the request had is kept", async () => {
        const world = { groups: [album("road", "Abbey Road", "The Beatles")] };
        expect(await ids(world, { title: "Abbey Road Studio Sessions", artist: "The Beatles" })).toEqual(["road"]);
    });

    test("without a recognizable artist, extra words only cost score", async () => {
        const world = { groups: [album("love", "Greatest Love", "Somebody Else")] };
        const [hit] = (await searchAlbums({ title: "Greatest" }, stubDeps(world, { covered: ["love"] }))).results;
        expect(hit?.id).toBe("love");
        expect(hit!.match.title).toBeLessThan(1);
    });

    test("version descriptors are stripped from both sides before comparing", async () => {
        const world = { groups: [album("road", "Abbey Road (Bonus Track Version)", "The Beatles")] };
        expect(await ids(world, { title: "Abbey Road", artist: "The Beatles" })).toEqual(["road"]);
        expect(await ids(world, { title: "Abbey Road [Explicit]", artist: "The Beatles" })).toEqual(["road"]);
    });

    test("a different artist's same-titled work is dropped by the artist floor", async () => {
        const world = { groups: [album("a", "Thriller", "Michael Jackson"), album("b", "Thriller", "Some Cover Band")] };
        expect(await ids(world, { title: "Thriller", artist: "Michael Jackson" })).toEqual(["a"]);
    });

    test("typos in the artist and the title are tolerated", async () => {
        const world = { groups: [album("rumours", "Rumours", "Fleetwood Mac")] };
        expect(await ids(world, { title: "Rumors", artist: "Fleetwod Mac" })).toEqual(["rumours"]);
    });

    test("extra words that name a different recording reject a track: studio request, live candidate", async () => {
        const world = {
            groups: [album("g", "Hits", "Adele"), album("h", "Live", "Adele")],
            recordings: [
                { id: "studio", title: "Hello", artist: "Adele", on: [{ group: "g", release: { id: "g-r1" } }] },
                { id: "live", title: "Hello (Live at Wembley)", artist: "Adele", on: [{ group: "h", release: { id: "h-r1" } }] }
            ]
        };
        const found = (await searchTracks({ title: "Hello", artist: "Adele" }, stubDeps(world, { covered: ["g", "h", "g-r1", "h-r1"] }))).results.map((r) => r.id);
        expect(found).toEqual(["studio"]);
        const live = (await searchTracks({ title: "Hello (Live at Wembley)", artist: "Adele" }, stubDeps(world, { covered: ["g", "h", "g-r1", "h-r1"] }))).results.map((r) => r.id);
        expect(live[0]).toBe("live");
    });

    test("a recording's 'live' disambiguation counts as part of its title", async () => {
        const world = {
            groups: [album("g", "Studio", "Adele"), album("h", "Concert", "Adele")],
            recordings: [
                { id: "studio", title: "Hello", artist: "Adele", on: [{ group: "g", release: { id: "g-r1" } }] },
                { id: "live", title: "Hello", disambiguation: "live, 2016-11-01: Wembley Arena", artist: "Adele", on: [{ group: "h", release: { id: "h-r1" } }] }
            ]
        } as Parameters<typeof stubDeps>[0];
        const found = (await searchTracks({ title: "Hello", artist: "Adele" }, stubDeps(world, { covered: ["g", "h"] }))).results.map((r) => r.id);
        expect(found).toEqual(["studio"]);
    });
});

describe("cross-script artist matching through aliases and sort names", () => {
    const callas = artist("Maria Callas", ["Мария Каллас", "マリア・カラス"], "callas", "Callas, Maria");
    const utada = artist("宇多田ヒカル", ["Utada Hikaru"], "utada", "Utada, Hikaru");
    const world = {
        groups: [album("traviata", "La Traviata", callas), album("firstlove", "First Love", utada), album("other", "La Traviata", "Somebody Else")]
    };

    test("Cyrillic query finds the Latin-named artist", async () => {
        expect(await ids(world, { title: "La Traviata", artist: "Мария Каллас" })).toEqual(["traviata"]);
    });

    test("Latin query finds the Japanese-named artist", async () => {
        expect(await ids(world, { title: "First Love", artist: "Utada Hikaru" })).toEqual(["firstlove"]);
        expect(await ids(world, { title: "First Love", artist: "宇多田ヒカル" })).toEqual(["firstlove"]);
        expect(await ids(world, { title: "First Love", artist: "うただひかる" })).toEqual([]);
    });

    test("the sort name is a name too", async () => {
        expect(await ids(world, { title: "La Traviata", artist: "Callas, Maria" })).toEqual(["traviata"]);
    });

    test("'Artist - Title' is tried in both orders", async () => {
        expect(await ids(world, { q: "First Love - Utada Hikaru" })).toEqual(["firstlove"]);
        expect(await ids(world, { q: "Utada Hikaru - First Love" })).toEqual(["firstlove"]);
    });
});
