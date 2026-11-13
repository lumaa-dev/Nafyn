import { describe, expect, test } from "bun:test";
import { externalQuery, externalSearchUrl } from "../app/utils/externalLinks";

describe("externalLinks", () => {
    test("query is artist then title, unknown parts skipped", () => {
        expect(externalQuery("One Trick", "Lovejoy")).toBe("Lovejoy One Trick");
        expect(externalQuery("Song", null)).toBe("Song");
        expect(externalQuery("  ", " A ")).toBe("A");
    });

    test("every service encodes the query", () => {
        expect(externalSearchUrl("spotify", "test query")).toBe("https://open.spotify.com/search/test%20query");
        expect(externalSearchUrl("appleMusic", "a&b")).toBe("https://music.apple.com/search?term=a%26b");
        expect(externalSearchUrl("deezer", "test query")).toBe("https://www.deezer.com/search/test%20query");
        expect(externalSearchUrl("youtube", "test query")).toBe("https://www.youtube.com/results?search_query=test%20query");
        expect(externalSearchUrl("youtubeMusic", "二十歳の恋")).toBe(`https://music.youtube.com/search?q=${encodeURIComponent("二十歳の恋")}`);
    });
});
