import { describe, expect, test } from "bun:test";
import { DEFAULT_SEARCH_CONFIG } from "../../../server/utils/search/config";
import { artistRelevance, mergeByLikelihood, type RankedEntry } from "../../../server/utils/search/mixed";

const row = (kind: RankedEntry<string>["kind"], relevance: number, item: string): RankedEntry<string> => ({ kind, relevance, item });

describe("mergeByLikelihood", () => {
    test("the likeliest head comes next, and no list is reordered", () => {
        const merged = mergeByLikelihood(
            [row("album", 0.9, "a1"), row("album", 0.95, "a2-uncovered-ranks-lower-but-scores-higher")],
            [row("track", 0.92, "t1"), row("track", 0.6, "t2")],
            [row("artist", 0.7, "r1")]
        );
        expect(merged.map((entry) => entry.item)).toEqual(["t1", "a1", "a2-uncovered-ranks-lower-but-scores-higher", "r1", "t2"]);
    });

    test("a tie goes artist, then album, then track", () => {
        const merged = mergeByLikelihood([row("track", 1, "t")], [row("album", 1, "a")], [row("artist", 1, "r")]);
        expect(merged.map((entry) => entry.item)).toEqual(["r", "a", "t"]);
    });

    test("empty lists are fine", () => {
        expect(mergeByLikelihood([], [])).toEqual([]);
    });
});

describe("artistRelevance", () => {
    test("the name, an alias and a different artist", () => {
        const weezer = { name: "Weezer", "sort-name": "Weezer", aliases: [] };
        expect(artistRelevance("weezer", weezer, DEFAULT_SEARCH_CONFIG)).toBeGreaterThan(0.95);
        expect(artistRelevance("weezer", { name: "Reezer", aliases: [] }, DEFAULT_SEARCH_CONFIG)).toBeLessThan(0.9);
        expect(artistRelevance("weezer", { name: "Radiohead", aliases: [] }, DEFAULT_SEARCH_CONFIG)).toBeLessThan(0.3);
        const utada = { name: "宇多田ヒカル", aliases: [{ name: "Utada Hikaru" }] };
        expect(artistRelevance("Utada Hikaru", utada, DEFAULT_SEARCH_CONFIG)).toBeGreaterThan(0.95);
    });
});
