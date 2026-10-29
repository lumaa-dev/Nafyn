// Free text that is an artist and a title in one string, in any order, with words skipped or misspelled.
// Real MusicBrainz data for the same queries is in regression.test.ts; these run on a tiny world.

import { describe, expect, test } from "bun:test";
import { searchAlbums } from "../../../server/utils/search/engine";
import { album, stubDeps } from "./stub";

const world = {
    groups: [
        album("trick", "One Simple Trick", "Lovejoy"),
        album("pebble", "Pebble Brain", "Lovejoy"),
        album("other-trick", "This One Simple Trick", "Kaleidobolt"),
        album("trench", "A season in the dark, a bottomless trench", "Feldup"),
        album("seasons", "Seasons of Dark", "Dark Divinity"),
        album("zep", "Led Zeppelin", "Led Zeppelin"),
        album("zep2", "Led Zeppelin II", "Led Zeppelin"),
        album("zippy", "Led Zeppelin, My Identity", "Zippy Kid")
    ],
    artists: [
        { id: "artist-Lovejoy", name: "Lovejoy", score: 100 },
        { id: "artist-Feldup", name: "Feldup", score: 100 }
    ]
};
const covered = world.groups.flatMap((group) => [group.id, `${group.id}-r1`]);
const search = async (q: string) => (await searchAlbums({ q }, stubDeps(world, { covered }))).results;

describe("artist and title in one string", () => {
    test.each([
        ["lovejoy one simple trick", "trick"],
        ["one simple lovejoy", "trick"],
        ["lovejoy one trick", "trick"],
        ["feldup season in the dark", "trench"],
        ["bottomless trench feldup", "trench"],
        ["feldup bottom less tranch", "trench"]
    ])("%s", async (q, id) => {
        const results = await search(q);
        expect(results[0]!.id).toBe(id);
        expect(results[0]!.bestResult).toBe(true);
        expect(results[0]!.match.flags).toContain("artist_in_query");
        expect(results[0]!.match.artist).toBeGreaterThanOrEqual(0.85);
    });

    test("the artist's other albums have no title in the text and are not returned", async () => {
        expect((await search("lovejoy one simple trick")).map((r) => r.id)).not.toContain("pebble");
    });

    test("the whole title still outranks a split of the same words", async () => {
        const [first, second] = await search("one simple trick");
        expect(first!.id).toBe("trick");
        expect(first!.match.flags).not.toContain("artist_in_query");
        expect(first!.match.relevance).toBeGreaterThan(second?.match.relevance ?? 0);
    });

    test("a text that is only the artist is still the artist's albums, not a joint reading", async () => {
        const results = await search("led zeppelin");
        expect(results[0]!.id).toBe("zep");
        expect(results.slice(1).every((r) => r.match.flags.includes("artist_only") || r.id === "zippy")).toBe(true);
        expect(results.filter((r) => r.match.flags.includes("artist_in_query"))).toEqual([]);
    });

    test("fields given explicitly are never split again", async () => {
        const deps = stubDeps(world, { covered });
        const results = (await searchAlbums({ title: "one trick", artist: "Lovejoy" }, deps)).results;
        expect(results.every((r) => !r.match.flags.includes("artist_in_query"))).toBe(true);
    });
});

describe("half of an album title", () => {
    test.each([
        ["a season in the dark"],
        ["a bottomles trench"]
    ])("%s names the album, and is its best result", async (q) => {
        const results = await search(q);
        expect(results[0]!.id).toBe("trench");
        expect(results[0]!.bestResult).toBe(true);
    });

    test("an exact clause outranks a look-alike title", async () => {
        const results = await search("a season in the dark");
        const trench = results.find((r) => r.id === "trench")!;
        const seasons = results.find((r) => r.id === "seasons");
        expect(trench.match.relevance).toBeGreaterThan((seasons?.match.relevance ?? 0) + 0.08);
    });

    test("a two-word clause is a weaker hint than a name: the artist's own albums stay ahead of 'Led Zeppelin, My Identity'", async () => {
        const results = await search("led zeppelin");
        const own = results.find((r) => r.id === "zep2")!;
        const clause = results.find((r) => r.id === "zippy");
        expect(clause === undefined || clause.match.relevance < own.match.relevance).toBe(true);
    });

    test("only for free text: asked by title and artist, a subtitle is another work", async () => {
        const deps = stubDeps({ groups: [album("take", "First Love - From THE FIRST TAKE", "Utada")], artists: [] }, { covered: ["take", "take-r1"] });
        expect((await searchAlbums({ title: "First Love", artist: "Utada" }, deps)).results).toEqual([]);
        expect((await searchAlbums({ q: "First Love utada" }, deps)).results.map((r) => r.id)).toEqual(["take"]);
    });
});
