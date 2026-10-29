import { describe, expect, test } from "bun:test";
import { acceptSearchResult, coreTitle, pickIsrcRecording, primaryArtist, searchForms } from "../server/utils/trackPick";
import type { SearchResult } from "../server/utils/search/types";

describe("title and artist forms", () => {
    test("core title drops what catalogs disagree on", () => {
        expect(coreTitle("Get Lucky (feat. Pharrell Williams) - Radio Edit")).toBe("Get Lucky");
        expect(coreTitle("Here Comes the Sun [2019 Mix]")).toBe("Here Comes the Sun");
        expect(coreTitle("Song feat. Someone")).toBe("Song");
        expect(coreTitle("(What's the Story) Morning Glory?")).toBe("Morning Glory?");
        expect(coreTitle("[Untitled]")).toBe("[Untitled]");
    });

    test("the first of several artists, never for one", () => {
        expect(primaryArtist("Daft Punk & Pharrell Williams")).toBe("Daft Punk");
        expect(primaryArtist("Lil Nas X, Jack Harlow")).toBe("Lil Nas X");
        expect(primaryArtist("Marshmello x Bastille")).toBe("Marshmello");
        expect(primaryArtist("Lovejoy")).toBeNull();
        expect(primaryArtist("Charli XCX")).toBeNull();
    });

    test("search forms: as given first, a duo is tried whole before its first name", () => {
        expect(searchForms('Lose Yourself (From "8 Mile")', "Eminem & Dr. Dre")).toEqual([
            { title: 'Lose Yourself (From "8 Mile")', artist: "Eminem & Dr. Dre" },
            { title: "Lose Yourself", artist: "Eminem & Dr. Dre" },
            { title: 'Lose Yourself (From "8 Mile")', artist: "Eminem" },
            { title: "Lose Yourself", artist: "Eminem" }
        ]);
        // what the engine's own cleaning already removes is not searched twice
        expect(searchForms("Mrs. Robinson - Remastered", "Simon & Garfunkel")).toHaveLength(2);
        expect(searchForms("Song", "Artist")).toEqual([{ title: "Song", artist: "Artist" }]);
    });
});

describe("pickIsrcRecording", () => {
    const credit = (name: string) => [{ name, artist: { name } }];

    test("one recording is the answer", () => {
        expect(pickIsrcRecording([{ id: "only" }], { title: "x" })?.id).toBe("only");
        expect(pickIsrcRecording([], { title: "x" })).toBeNull();
    });

    test("the recording whose title, artist and length agree wins over the first listed", () => {
        const picked = pickIsrcRecording([
            { id: "live", title: "Crazy Eyes (live)", length: 260_000, "artist-credit": credit("Daryl Hall & John Oates") },
            { id: "other", title: "Something Else", length: 183_600, "artist-credit": credit("Somebody") },
            { id: "studio", title: "Crazy Eyes", length: 183_600, "artist-credit": credit("Daryl Hall & John Oates") }
        ], { title: "Crazy Eyes", artist: "Daryl Hall & John Oates", duration: 184 });
        expect(picked?.id).toBe("studio");
    });

    test("with only a length to go on, the closest one", () => {
        const picked = pickIsrcRecording([{ id: "a", length: 300_000 }, { id: "b", length: 201_000 }], { duration: 200 });
        expect(picked?.id).toBe("b");
    });
});

describe("acceptSearchResult", () => {
    const result = (id: string, relevance: number, lengthSeconds: number | null, flags: string[] = []) => ({
        kind: "track", id, title: id, artist: { name: "a", id: null }, primaryType: null, secondaryTypes: [], releaseDate: null,
        releaseId: null, releaseTitle: null, albumId: null, length: lengthSeconds === null ? null : lengthSeconds * 1000,
        hasFrontCover: true, bestResult: false,
        match: { title: 1, artist: 1, relevance, exactness: 1, sources: 1, flags }
    }) as unknown as SearchResult;
    const options = { minScore: 0.8, durationMinScore: 0.7 };

    test("a strong result whose length agrees beats a stronger one that is another edit", () => {
        expect(acceptSearchResult([result("edit", 0.95, 260), result("album", 0.85, 201)], { duration: 200 }, options)?.id).toBe("album");
    });

    test("a decent result is taken when its length agrees", () => {
        expect(acceptSearchResult([result("decent", 0.74, 199)], { duration: 200 }, options)?.id).toBe("decent");
        expect(acceptSearchResult([result("decent", 0.74, null)], { duration: 200 }, options)).toBeNull();
    });

    test("without a length, the score alone decides; a code contradiction never passes", () => {
        expect(acceptSearchResult([result("strong", 0.9, 300)], {}, options)?.id).toBe("strong");
        expect(acceptSearchResult([result("weak", 0.6, 200)], { duration: 200 }, options)).toBeNull();
        expect(acceptSearchResult([result("x", 0.99, 200, ["code_contradiction"])], { duration: 200 }, options)).toBeNull();
    });

    test("a strong result clearly another edit is refused", () => {
        expect(acceptSearchResult([result("live", 0.95, 300)], { duration: 200 }, options)).toBeNull();
    });
});
