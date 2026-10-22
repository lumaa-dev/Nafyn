import { describe, expect, test } from "bun:test";
import { DEFAULT_SEARCH_CONFIG as config } from "../../server/utils/search/config";
import { compareResults, dedupe, markBestResult, searchAlbums } from "../../server/utils/search/engine";
import type { MatchFlag, SearchResult } from "../../server/utils/search/types";
import { album, stubDeps } from "./stub";

function result(id: string, overrides: Partial<SearchResult> & { relevance?: number, artist?: number, exactness?: number, flags?: MatchFlag[] } = {}): SearchResult {
    const { relevance = 0.9, artist = 1, exactness = 1, flags = [], ...rest } = overrides;
    return {
        kind: "album", id, title: `Title ${id}`, artist: { name: "Artist", id: "a" }, primaryType: "Album", secondaryTypes: [],
        releaseDate: "2000-01-01", releaseId: `${id}-r`, releaseTitle: null, albumId: id, length: null, hasFrontCover: true,
        match: { title: 1, artist, relevance, exactness, sources: 1, flags }, bestResult: false, ...rest
    };
}

const rank = (...results: SearchResult[]) => results.sort((a, b) => compareResults(a, b)).map((r) => r.id);

describe("cover-first lexicographic ranking", () => {
    test("a covered result beats an uncovered one with a higher relevance - by design", () => {
        expect(rank(
            result("exact-no-cover", { hasFrontCover: false, relevance: 1.0 }),
            result("good-with-cover", { relevance: 0.7 })
        )).toEqual(["good-with-cover", "exact-no-cover"]);
    });

    test("then relevance, artist score, exactness", () => {
        expect(rank(result("a", { relevance: 0.8 }), result("b", { relevance: 0.9 }))).toEqual(["b", "a"]);
        expect(rank(result("a", { artist: 0.8 }), result("b", { artist: 1 }))).toEqual(["b", "a"]);
        expect(rank(result("a", { exactness: 0.8 }), result("b", { exactness: 1 }))).toEqual(["b", "a"]);
    });

    test("then primary type: Album > EP > Single, configurable", () => {
        const set = () => [result("single", { primaryType: "Single" }), result("ep", { primaryType: "EP" }), result("album", { primaryType: "Album" })];
        expect(set().sort((a, b) => compareResults(a, b)).map((r) => r.id)).toEqual(["album", "ep", "single"]);
        expect(set().sort((a, b) => compareResults(a, b, ["single", "ep", "album"])).map((r) => r.id)).toEqual(["single", "ep", "album"]);
    });

    test("then the earliest release date (undated last), then the MBID", () => {
        expect(rank(result("a", { releaseDate: "2010" }), result("b", { releaseDate: "2001-05" }), result("c", { releaseDate: null }))).toEqual(["b", "a", "c"]);
        expect(rank(result("b"), result("a"))).toEqual(["a", "b"]);
    });

    test("float noise in a score does not outrank the later keys", () => {
        expect(rank(result("late", { relevance: 0.9000001, releaseDate: "2020" }), result("early", { relevance: 0.9, releaseDate: "2000" }))).toEqual(["early", "late"]);
    });

    test("the relevance gate runs before the cover key: an irrelevant covered result never surfaces", async () => {
        const world = {
            groups: [
                album("right", "Nevermind", "Nirvana"),
                album("noise", "Completely Unrelated Record", "Other Band")
            ]
        };
        // only the irrelevant one has a cover
        const deps = stubDeps(world, { covered: ["noise", "noise-r1"] });
        const ids = (await searchAlbums({ title: "Nevermind", artist: "Nirvana" }, deps)).results.map((r) => r.id);
        expect(ids).toEqual(["right"]);
    });

    test("a correct match without a front cover is still returned, flagged, below a covered relevant one", async () => {
        const world = {
            groups: [
                album("nevermind", "Nevermind", "Nirvana"),
                album("utero", "In Utero", "Nirvana")
            ]
        };
        const deps = stubDeps(world, { covered: ["utero", "utero-r1"] });
        // asked for Nevermind by name, the artist's other covered record is still a relevant hit (same artist)
        const results = (await searchAlbums({ q: "Nirvana" }, deps)).results;
        expect(results.map((r) => r.id)).toEqual(["utero", "nevermind"]);
        expect(results[1]!.hasFrontCover).toBe(false);
        expect(results[1]!.match.flags).toContain("no_front_cover");
        expect(results.some((r) => r.bestResult)).toBe(false);
    });
});

describe("best_result", () => {
    const ranked = (...entries: SearchResult[]) => markBestResult([...entries], config);
    const flagged = (results: SearchResult[]) => results.filter((r) => r.bestResult).map((r) => r.id);

    test("flags the top result when it clears the score, has a cover and leads by the margin", () => {
        expect(flagged(ranked(result("a", { relevance: 1 }), result("b", { relevance: 0.8 })))).toEqual(["a"]);
    });

    test("never more than one result is flagged", () => {
        const results = ranked(result("a", { relevance: 1 }), result("b", { relevance: 0.5 }), result("c", { relevance: 0.4 }));
        expect(results.filter((r) => r.bestResult)).toHaveLength(1);
        expect(results[0]!.bestResult).toBe(true);
    });

    test("a runner-up inside the margin makes it ambiguous: nobody is flagged", () => {
        expect(flagged(ranked(result("a", { relevance: 1 }), result("b", { relevance: 1 - config.bestResultMargin + 0.01 })))).toEqual([]);
        expect(flagged(ranked(result("a", { relevance: 1 }), result("b", { relevance: 1 - config.bestResultMargin - 0.01 })))).toEqual(["a"]);
        expect(flagged(ranked(result("a", { relevance: 1 }), result("b", { relevance: 1 })))).toEqual([]);
    });

    test("the score must clear the minimum", () => {
        expect(flagged(ranked(result("a", { relevance: config.bestResultMinScore - 0.01 })))).toEqual([]);
        expect(flagged(ranked(result("a", { relevance: config.bestResultMinScore })))).toEqual(["a"]);
    });

    test("it needs a front cover or an exact UPC/ISRC match", () => {
        expect(flagged(ranked(result("a", { relevance: 1, hasFrontCover: false })))).toEqual([]);
        expect(flagged(ranked(result("a", { relevance: 1, hasFrontCover: false, flags: ["upc_match"] })))).toEqual(["a"]);
        expect(flagged(ranked(result("a", { relevance: 1, hasFrontCover: false, flags: ["isrc_match"] })))).toEqual(["a"]);
        expect(flagged(ranked(result("a", { relevance: 1, hasFrontCover: false, flags: ["code_contradiction"] })))).toEqual([]);
    });

    test("a cover-less top result with an uncovered-but-better runner-up cannot be flagged either", () => {
        // ranked order is cover-first, so the top has the LOWER score: the margin is negative
        expect(flagged(ranked(result("covered", { relevance: 0.85 }), result("uncovered", { relevance: 1, hasFrontCover: false })))).toEqual([]);
    });

    test("the thresholds are configurable", () => {
        const strict = { ...config, bestResultMargin: 0.5 };
        expect(markBestResult([result("a", { relevance: 1 }), result("b", { relevance: 0.8 })], strict).filter((r) => r.bestResult)).toEqual([]);
    });

    test("nothing to flag in an empty list; a lone result is flagged when good enough", () => {
        expect(markBestResult([], config)).toEqual([]);
        expect(flagged(ranked(result("only", { relevance: 0.95 })))).toEqual(["only"]);
    });

    test("end to end through the engine", async () => {
        const world = { groups: [album("a", "Nevermind", "Nirvana"), album("b", "Nevermind Remix Collection", "Nirvana", { secondary: [] })] };
        const deps = stubDeps(world, { covered: ["a", "a-r1", "b", "b-r1"] });
        const results = (await searchAlbums({ title: "Nevermind", artist: "Nirvana" }, deps)).results;
        expect(results.filter((r) => r.bestResult).length).toBeLessThanOrEqual(1);
    });
});

describe("dedupe", () => {
    test("keeps the best-ranked of identical works; tracks of clearly different length stay apart", () => {
        const a = result("a");
        const b = { ...result("b"), title: a.title };
        expect(dedupe([a, b], "album", config).map((r) => r.id)).toEqual(["a"]);

        const t1 = { ...result("t1"), kind: "track" as const, title: "Song", length: 200_000 };
        const t2 = { ...result("t2"), kind: "track" as const, title: "Song", length: 201_000 };
        const t3 = { ...result("t3"), kind: "track" as const, title: "Song", length: 260_000 };
        expect(dedupe([t1, t2, t3], "track", config).map((r) => r.id)).toEqual(["t1", "t3"]);
    });
});
