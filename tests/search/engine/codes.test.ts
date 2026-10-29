import { describe, expect, test } from "bun:test";
import { barcodeForms, hasValidGtinCheckDigit, parseIsrc, parseUpc, sameBarcode } from "../../../server/utils/search/codes";
import { searchAlbums, searchTracks } from "../../../server/utils/search/engine";
import { album, artist, stubDeps } from "./stub";

describe("UPC/EAN validation", () => {
    test("valid 12 and 13 digit codes", () => {
        expect(parseUpc("075678263323").value).toBe("075678263323");
        expect(parseUpc("0603497920068").value).toBe("0603497920068");
        expect(parseUpc("5012345678900").value).toBe("5012345678900");
    });

    test("separators are tolerated", () => {
        expect(parseUpc("0756-7826-3323").value).toBe("075678263323");
        expect(parseUpc(" 075678263323 ").value).toBe("075678263323");
    });

    test("bad check digit, wrong length, non-numeric", () => {
        expect(parseUpc("075678263324").value).toBeNull();
        expect(parseUpc("07567826332").value).toBeNull();
        expect(parseUpc("07567826332300").value).toBeNull();
        expect(parseUpc("07567826332A").value).toBeNull();
        expect(parseUpc("").value).toBeNull();
        expect(parseUpc(undefined).value).toBeNull();
        expect(parseUpc("075678263324").reason).toBe("bad check digit");
    });

    test("check digit arithmetic", () => {
        expect(hasValidGtinCheckDigit("4006381333931")).toBe(true);
        expect(hasValidGtinCheckDigit("4006381333932")).toBe(false);
    });

    test("a UPC-A is also an EAN-13 with a leading zero", () => {
        expect(barcodeForms("075678263323")).toEqual(["075678263323", "0075678263323"]);
        expect(sameBarcode("0075678263323", "075678263323")).toBe(true);
        expect(sameBarcode("075678263323", "075678263323")).toBe(true);
        expect(sameBarcode("075678263330", "075678263323")).toBe(false);
        expect(sameBarcode(null, "075678263323")).toBe(false);
    });
});

describe("ISRC validation", () => {
    test("valid, with and without hyphens, any case", () => {
        expect(parseIsrc("GBAHT1600302").value).toBe("GBAHT1600302");
        expect(parseIsrc("GB-AHT-16-00302").value).toBe("GBAHT1600302");
        expect(parseIsrc("gbaht1600302").value).toBe("GBAHT1600302");
        expect(parseIsrc("QM6MZ2000123").value).toBe("QM6MZ2000123");
    });

    test("wrong length or structure", () => {
        expect(parseIsrc("GBAHT160030").value).toBeNull();
        expect(parseIsrc("GBAHT16003022").value).toBeNull();
        expect(parseIsrc("1BAHT1600302").value).toBeNull();
        expect(parseIsrc("GBAHT16A0302").value).toBeNull();
        expect(parseIsrc("").value).toBeNull();
        expect(parseIsrc(42).value).toBeNull();
    });
});

const zep = artist("Led Zeppelin");

describe("UPC lookup and fallback", () => {
    const world = {
        groups: [
            album("two", "Led Zeppelin II", zep, { releases: [{ id: "two-cd", format: "CD", barcode: "075678263323", date: "1994" }, { id: "two-dig", date: "2014" }] }),
            album("four", "Led Zeppelin IV", zep, { releases: [{ id: "four-dig", date: "2014", barcode: "603497920068" }] }),
            album("cdonly", "Obscure", "Nobody", { releases: [{ id: "obs-cd", format: "CD", barcode: "5012345678900" }] })
        ]
    };

    test("a code hit is flagged, boosted, and wins without a cover", async () => {
        const logs: string[] = [];
        const deps = stubDeps(world, { covered: [], log: (m) => logs.push(m) });
        const { results } = await searchAlbums({ title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "075678263323" }, deps);
        expect(results[0]!.id).toBe("two");
        expect(results[0]!.match.flags).toContain("upc_match");
        expect(results[0]!.match.relevance).toBeGreaterThan(1);
        expect(results[0]!.hasFrontCover).toBe(false);
        // no cover, but an exact code match is enough for best_result
        expect(results[0]!.bestResult).toBe(true);
        // the barcode was enough: the title search never ran
        expect(deps.repo.calls.some((call) => call.path === "/release-group")).toBe(false);
    });

    test("an invalid code is ignored with a log line, not an error", async () => {
        const logs: string[] = [];
        const deps = stubDeps(world, { covered: ["two"], log: (m) => logs.push(m) });
        const { results } = await searchAlbums({ title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "075678263324" }, deps);
        expect(results.map((r) => r.id)).toEqual(["two"]);
        expect(logs.some((line) => /ignoring invalid upc/.test(line))).toBe(true);
        expect(deps.repo.calls.some((call) => call.query.startsWith("barcode"))).toBe(false);
    });

    test("an unknown code falls back to title + artist", async () => {
        const logs: string[] = [];
        const deps = stubDeps(world, { covered: ["two"], log: (m) => logs.push(m) });
        const { results } = await searchAlbums({ title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "012345678905" }, deps);
        expect(results.map((r) => r.id)).toEqual(["two"]);
        expect(results[0]!.match.flags).not.toContain("upc_match");
        expect(logs.some((line) => /falling back/.test(line))).toBe(true);
    });

    test("a code whose hits all fail the hard filters falls back too", async () => {
        // the barcode belongs to a CD-only record, so it can never be returned…
        const deps = stubDeps(world, { covered: ["two"] });
        const { results } = await searchAlbums({ title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "5012345678900" }, deps);
        // …and the title search still answers
        expect(results.map((r) => r.id)).toEqual(["two"]);
    });

    test("a near-miss barcode returned by MusicBrainz' text search is not trusted", async () => {
        const nearMiss = { groups: [album("x", "Something Else", "Someone", { releases: [{ id: "x1", barcode: "075678263330" }] })] };
        const deps = stubDeps({ ...nearMiss }, { covered: ["x"] });
        // the stub only returns releases whose barcode equals a requested form, so emulate the loose server
        const loose = { async request<T>(path: string, params: { query?: string }) { return (path === "/release" && String(params.query).startsWith("barcode") ? await deps.repo.request<T>(path, { query: "rgid:(x)" }) : await deps.repo.request<T>(path, params)); } };
        const { results } = await searchAlbums({ title: "Something Else", artist: "Someone", upc: "075678263323" }, { ...deps, repo: loose as never });
        expect(results[0]!.match.flags).not.toContain("upc_match");
    });

    test("a code that contradicts the title/artist loses confidence instead of being trusted", async () => {
        const world2 = {
            groups: [
                album("wrong", "Totally Different Record", "Other Artist", { releases: [{ id: "w1", barcode: "075678263323", date: "2000" }] }),
                album("two", "Led Zeppelin II", zep)
            ]
        };
        const deps = stubDeps(world2, { covered: ["wrong", "wrong-r1", "w1", "two", "two-r1"] });
        const { results } = await searchAlbums({ title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "075678263323" }, deps);
        // the title search ran as well, and the contradicting hit never became a confident answer
        expect(results[0]!.id).toBe("two");
        const wrong = results.find((r) => r.id === "wrong");
        expect(wrong?.match.flags ?? []).not.toContain("upc_match");
        expect(results.filter((r) => r.bestResult).map((r) => r.id)).not.toContain("wrong");
    });

    test("codes need not be consistent with the other kind: ISRC is ignored when searching albums", async () => {
        const deps = stubDeps(world, { covered: ["two"] });
        const { results } = await searchAlbums({ title: "Led Zeppelin II", artist: "Led Zeppelin", isrc: "GBAHT1600302" }, deps);
        expect(results.map((r) => r.id)).toEqual(["two"]);
        expect(deps.repo.calls.some((call) => call.query.startsWith("isrc"))).toBe(false);
    });
});

describe("ISRC lookup and fallback", () => {
    const world = {
        groups: [album("g", "Album", "Dua Lipa", { releases: [{ id: "g1", date: "2016" }] }), album("h", "Other Album", "Dua Lipa")],
        recordings: [
            { id: "rec", title: "Blow Your Mind (Mwah)", artist: "Dua Lipa", isrcs: ["GBAHT1600302"], on: [{ group: "g", release: { id: "g1" } }] },
            { id: "other", title: "Other Song", artist: "Dua Lipa", isrcs: ["GBAHT1600999"], on: [{ group: "h", release: { id: "h-r1" } }] }
        ]
    };

    test("hyphens in the input are tolerated; a match is flagged and boosted", async () => {
        const deps = stubDeps(world, { covered: [] });
        const { results } = await searchTracks({ title: "Blow Your Mind", artist: "Dua Lipa", isrc: "GB-AHT-16-00302" }, deps);
        expect(results[0]!.id).toBe("rec");
        expect(results[0]!.match.flags).toContain("isrc_match");
        expect(results[0]!.bestResult).toBe(true);
    });

    test("an unknown ISRC falls back to title + artist", async () => {
        const deps = stubDeps(world, { covered: ["g1"] });
        const { results } = await searchTracks({ title: "Blow Your Mind (Mwah)", artist: "Dua Lipa", isrc: "GBAHT9999999" }, deps);
        expect(results[0]!.id).toBe("rec");
        expect(results[0]!.match.flags).not.toContain("isrc_match");
    });

    test("an ISRC that points at a different song is flagged as contradicting, not trusted", async () => {
        const deps = stubDeps(world, { covered: ["g1", "h-r1", "h", "g"] });
        const { results } = await searchTracks({ title: "Blow Your Mind (Mwah)", artist: "Dua Lipa", isrc: "GBAHT1600999" }, deps);
        expect(results[0]!.id).toBe("rec");
        const other = results.find((r) => r.id === "other");
        expect(other?.match.flags ?? []).not.toContain("isrc_match");
    });
});
