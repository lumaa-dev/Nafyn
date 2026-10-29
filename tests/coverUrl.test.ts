import { describe, expect, test } from "bun:test";
import { coverArchiveUrl, coverArtPath, parseCoverArtUrl, rewriteCoverUrls, toArchiveCoverUrl, toArtPath } from "../server/utils/coverUrl";

const ID = "57d337a3-b4d2-4936-8daf-bb19c2ccbf14";
const ARCHIVE = `https://coverartarchive.org/release-group/${ID}/front-250`;
const PATH = `/api/v1/art/release-group/${ID}/250`;

describe("cover URL spellings", () => {
    test("both spellings parse to the same parts", () => {
        expect(parseCoverArtUrl(ARCHIVE)).toEqual({ kind: "release-group", id: ID, size: 250 });
        expect(parseCoverArtUrl(PATH)).toEqual({ kind: "release-group", id: ID, size: 250 });
    });

    test("they convert into each other", () => {
        expect(toArtPath(ARCHIVE)).toBe(PATH);
        expect(toArchiveCoverUrl(PATH)).toBe(ARCHIVE);
        expect(toArtPath(PATH)).toBe(PATH);
        expect(coverArtPath("release", ID.toUpperCase(), 500)).toBe(`/api/v1/art/release/${ID}/500`);
        expect(coverArchiveUrl("release", ID, 1000)).toBe(`https://coverartarchive.org/release/${ID}/front-1000`);
    });

    test("anything else is left alone", () => {
        for (const other of [
            "https://e-cdns-images.dzcdn.net/images/cover/abc/250x250.jpg",
            "/api/v1/library/abc/cover",
            `https://coverartarchive.org/release/${ID}/front-300`,
            `https://coverartarchive.org/release/not-a-uuid/front-250`,
            `/api/v1/art/release/${ID}/300`,
            `http://coverartarchive.org/release/${ID}/front-250`,
            `https://evil.example/https://coverartarchive.org/release/${ID}/front-250`
        ]) {
            expect(parseCoverArtUrl(other)).toBeNull();
            expect(toArtPath(other)).toBe(other);
            expect(toArchiveCoverUrl(other)).toBe(other);
        }
    });
});

describe("rewriteCoverUrls", () => {
    test("rewrites nested archive URLs and nothing else", () => {
        const date = new Date(0);
        const body = {
            items: [{ id: "a", coverArt: ARCHIVE, note: `see ${ARCHIVE}`, other: "https://example.org/x.jpg", at: date }],
            coverArt: null,
            total: 1
        };
        const out = rewriteCoverUrls(body);
        expect(out.items[0]!.coverArt).toBe(PATH);
        expect(out.items[0]!.note).toBe(`see ${ARCHIVE}`);
        expect(out.items[0]!.other).toBe("https://example.org/x.jpg");
        expect(out.items[0]!.at).toBe(date);
        expect(out.coverArt).toBeNull();
    });

    test("never mutates its input, and returns unchanged branches as the same object", () => {
        const untouched = { a: 1, list: ["x", "y"] };
        const body = { untouched, cover: ARCHIVE };
        const out = rewriteCoverUrls(body);
        expect(body.cover).toBe(ARCHIVE);
        expect(out.cover).toBe(PATH);
        expect(out.untouched).toBe(untouched);
        expect(rewriteCoverUrls(untouched)).toBe(untouched);
    });

    test("passes non-plain objects and primitives through", () => {
        const buffer = Buffer.from(ARCHIVE);
        expect(rewriteCoverUrls(buffer)).toBe(buffer);
        expect(rewriteCoverUrls(3)).toBe(3);
        expect(rewriteCoverUrls(null)).toBeNull();
    });
});
