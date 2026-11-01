import { describe, expect, test } from "bun:test";
import { isLibrarySort, likePattern, searchWords } from "../server/utils/libraryList";
import { NEW_USERNAME_RE } from "../server/utils/validation";

describe("library list query", () => {
	test("only the four sorts exist", () => {
		for (const sort of ["added", "title", "artist", "released"]) expect(isLibrarySort(sort)).toBe(true);
		for (const sort of ["", "name", "ADDED", undefined, 3]) expect(isLibrarySort(sort)).toBe(false);
	});

	test("search words are split, lowercased, deduplicated and capped", () => {
		expect(searchWords("  The   Strokes the ")).toEqual(["the", "strokes"]);
		expect(searchWords(undefined)).toEqual([]);
		expect(searchWords(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "))).toHaveLength(8);
	});

	test("LIKE wildcards in the text match themselves", () => {
		expect(likePattern("100%")).toBe("%100\\%%");
		expect(likePattern("a_b\\c")).toBe("%a\\_b\\\\c%");
	});
});

describe("new usernames", () => {
	test("lowercase letters, digits, _ and . only", () => {
		for (const ok of ["lumaa", "a.b_c9", "user_01", "abc"]) expect(NEW_USERNAME_RE.test(ok)).toBe(true);
		for (const bad of ["Lumaa", "UPPER", "a-b", "ab", "a".repeat(21), "sp ace", "émile", "a@b"]) expect(NEW_USERNAME_RE.test(bad)).toBe(false);
	});
});
