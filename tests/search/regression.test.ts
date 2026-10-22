// Tricky real searches replayed from recorded MusicBrainz / Cover Art Archive responses (no network).
// Expected MBIDs are the real ones. If MusicBrainz data has moved and a case needs refreshing:
//   bun run search:record <caseName>

import { describe, expect, test } from "bun:test";
import { CASES, type RegressionCase } from "./cases";
import { loadFixture, replayDeps } from "./replay";
import { searchAlbums, searchTracks } from "../../server/utils/search/engine";
import type { SearchResult } from "../../server/utils/search/types";

async function run(name: string, coverOverrides: Record<string, number> = {}): Promise<SearchResult[]> {
    const testCase = CASES.find((candidate: RegressionCase) => candidate.name === name)!;
    const deps = replayDeps(loadFixture(name), { coverOverrides });
    const search = testCase.kind === "album" ? searchAlbums : searchTracks;
    return (await search(testCase.input, deps, 50)).results;
}

const LED_ZEPPELIN = "0f18ec88-aa87-38a9-8a65-f03d81763560";
const LED_ZEPPELIN_II = "33b4653d-006e-3cc1-8afb-386b15a6cd6e";
const ABBEY_ROAD = "9162580e-5df4-32de-80cc-f45a8d8a9b1d";
const FIRST_LOVE = "c60fcd45-9420-30aa-98e5-2bffb894021a";
const GRUPPA_KROVI = "7ff1eff0-a8c8-37dc-807e-eea5a9e173b5";
const VENDETTA = "3d23a09b-2447-3425-977c-511d4da6ac67";
const DR_FEELGOOD = "2fc8cf0a-2370-3238-b4f3-0fcea1511c12";

describe("self-titled debut vs numbered sequels", () => {
    test("title + artist: only the debut, flagged best", async () => {
        const results = await run("debut-vs-sequel");
        expect(results.map((r) => r.id)).toEqual([LED_ZEPPELIN]);
        expect(results[0]!.bestResult).toBe(true);
    });

    test("free text 'Led Zeppelin': the debut leads the artist's other albums and is flagged", async () => {
        const results = await run("debut-vs-sequel-freetext");
        expect(results[0]!.id).toBe(LED_ZEPPELIN);
        expect(results[0]!.bestResult).toBe(true);
        expect(results.filter((r) => r.bestResult)).toHaveLength(1);
        expect(results.slice(1).every((r) => r.match.flags.includes("artist_only"))).toBe(true);
        expect(results.map((r) => r.id)).toContain(LED_ZEPPELIN_II);
    });
});

describe("remaster vs original", () => {
    test("by default the qualifying release is not a remaster", async () => {
        const [hit] = await run("remaster-default");
        expect(hit!.id).toBe(ABBEY_ROAD);
        expect(`${hit!.releaseTitle}`).not.toMatch(/remaster|deluxe/i);
    });

    test("asking for the remaster allows remaster releases (a different, earlier qualifying release)", async () => {
        const [original] = await run("remaster-default");
        const [asked] = await run("remaster-asked");
        expect(asked!.id).toBe(ABBEY_ROAD);
        expect(asked!.releaseId).not.toBe(original!.releaseId);
        expect(asked!.releaseDate! < original!.releaseDate!).toBe(true);
    });
});

describe("'Best of' exclusion", () => {
    test("an artist's albums contain no compilation and no best-of title", async () => {
        const results = await run("best-of-excluded");
        expect(results.length).toBeGreaterThan(3);
        for (const result of results) {
            expect(result.secondaryTypes).not.toContain("Compilation");
            expect(result.title).not.toMatch(/greatest hits|best of|essential|anthology|collection/i);
        }
    });

    test("asking for 'Greatest Hits' lifts the title heuristic but not the Compilation type", async () => {
        const results = await run("best-of-asked");
        expect(results.every((r) => !r.secondaryTypes.includes("Compilation"))).toBe(true);
    });
});

describe("scripts", () => {
    test("Japanese: kanji + katakana artist", async () => {
        const [hit] = await run("japanese");
        expect(hit!.id).toBe(FIRST_LOVE);
        expect(hit!.artist.name).toBe("宇多田ヒカル");
        expect(hit!.bestResult).toBe(true);
    });

    test("Japanese artist by her Latin alias", async () => {
        const [hit] = await run("japanese-latin-artist");
        expect(hit!.id).toBe(FIRST_LOVE);
        expect(hit!.match.artist).toBeGreaterThanOrEqual(0.99);
    });

    test("Cyrillic title and artist", async () => {
        const [hit] = await run("cyrillic");
        expect(hit!.id).toBe(GRUPPA_KROVI);
        expect(hit!.artist.name).toBe("Кино");
    });

    test("Cyrillic artist by her Latin alias, Cyrillic title", async () => {
        const [hit] = await run("cyrillic-latin-artist");
        expect(hit!.id).toBe(VENDETTA);
    });
});

describe("accents", () => {
    test("accented and unaccented queries give the same answer", async () => {
        const accented = await run("accented");
        const plain = await run("unaccented");
        expect(accented.map((r) => r.id)).toEqual([DR_FEELGOOD]);
        expect(plain.map((r) => r.id)).toEqual(accented.map((r) => r.id));
        expect(plain[0]!.match.relevance).toBe(accented[0]!.match.relevance);
    });
});

describe("UPC / ISRC", () => {
    test("a correct UPC is flagged and boosted", async () => {
        const [hit] = await run("upc-correct");
        expect(hit!.id).toBe(LED_ZEPPELIN_II);
        expect(hit!.match.flags).toContain("upc_match");
        expect(hit!.match.relevance).toBeGreaterThan(1.1);
    });

    test("a well-formed but unknown UPC falls back to title + artist", async () => {
        const results = await run("upc-unknown");
        expect(results.map((r) => r.id)).toEqual([LED_ZEPPELIN_II]);
        expect(results[0]!.match.flags).not.toContain("upc_match");
    });

    test("a correct ISRC finds the recording", async () => {
        const [hit] = await run("isrc-correct");
        expect(hit!.id).toBe("026fa041-3917-4c73-9079-ed16e36f20f8");
        expect(hit!.match.flags).toContain("isrc_match");
    });
});

describe("tracks", () => {
    test("live and bootleg recordings of the same song do not come back; the studio original leads", async () => {
        const results = await run("track-bootleg");
        expect(results[0]!.id).toBe("ccfdd180-22e1-49b9-bd81-b5fcf2c6474e");
        // the bootleg recording MusicBrainz returns for this query
        expect(results.map((r) => r.id)).not.toContain("6a9c98ba-d5a2-4b12-aab1-f16c6df0132a");
        for (const result of results) {
            expect(result.secondaryTypes).not.toContain("Compilation");
            expect(result.secondaryTypes).not.toContain("Live");
        }
    });

    test("'Artist - Title' gives the same answer as separate fields", async () => {
        const separate = await run("track-bootleg");
        const dashed = await run("track-artist-dash-title");
        expect(dashed.map((r) => r.id)).toEqual(separate.map((r) => r.id));
    });
});

describe("the correct album has no front cover", () => {
    test("it is still returned, flagged, and not called the best result", async () => {
        // pretend the Cover Art Archive has nothing for the debut's release or release-group
        // (the sequels keep their covers: only the release the debut is judged on loses it)
        const baseline = await run("debut-vs-sequel-freetext");
        const debut = baseline.find((r) => r.id === LED_ZEPPELIN)!;
        const only: Record<string, number> = {
            [`https://coverartarchive.org/release/${debut.releaseId}/front`]: 404,
            [`https://coverartarchive.org/release-group/${LED_ZEPPELIN}/front`]: 404
        };

        const results = await run("debut-vs-sequel-freetext", only);
        const index = results.findIndex((r) => r.id === LED_ZEPPELIN);
        expect(index).toBeGreaterThan(0);
        expect(results[index]!.hasFrontCover).toBe(false);
        expect(results[index]!.match.flags).toContain("no_front_cover");
        // covered, relevant results come first - and the cover-less debut (relevance 1.02) is not flagged
        expect(results.slice(0, index).every((r) => r.hasFrontCover)).toBe(true);
        expect(results.some((r) => r.bestResult)).toBe(false);
    });
});
