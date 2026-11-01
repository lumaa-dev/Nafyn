import { describe, expect, test } from "bun:test";
import { artistsShare, lyricsFitDuration, sameTrackByName, titleKey } from "../../server/utils/lyrics/match";
import { parseQRC } from "../../server/utils/lyrics/parser";

describe("sameTrackByName", () => {
	const lookup = { trackName: "Bad Decisions", artistName: "The Strokes" };

	test("the same song, however it is cased or punctuated", () => {
		expect(sameTrackByName(lookup, { song: "bad decisions", artist: "THE STROKES" })).toBe(true);
	});

	test("a featured guest is not another version", () => {
		expect(titleKey("Song (feat. Someone)")).toBe(titleKey("Song"));
		expect(sameTrackByName({ trackName: "Song", artistName: "A" }, { song: "Song (feat. B)", artist: "A, B" })).toBe(true);
	});

	test("another version or another artist is another song", () => {
		expect(sameTrackByName(lookup, { song: "Bad Decisions (Live)", artist: "The Strokes" })).toBe(false);
		expect(sameTrackByName(lookup, { song: "Bad Decisions - Acoustic", artist: "The Strokes" })).toBe(false);
		expect(sameTrackByName(lookup, { song: "Bad Decisions", artist: "Some Cover Band" })).toBe(false);
		expect(sameTrackByName(lookup, { song: "Bad Decision", artist: "The Strokes" })).toBe(false);
		expect(sameTrackByName(lookup, {})).toBe(false);
	});

	test("accents are not a difference", () => {
		expect(sameTrackByName({ trackName: "Déjà Vu", artistName: "Beyoncé" }, { song: "Deja Vu", artist: "Beyonce" })).toBe(true);
	});
});

describe("artistsShare", () => {
	test("one whole credited name is enough", () => {
		expect(artistsShare("Madlib & Madvillain", "Madvillain")).toBe(true);
		expect(artistsShare("A feat. B", "B")).toBe(true);
		expect(artistsShare("Artist One", "Artist")).toBe(false);
	});
});

describe("lyricsFitDuration", () => {
	const parsed = parseQRC("[0,2000]a(0,1000) (1000,1000)\n[100000,5000]b(100000,5000)")!;

	test("lyrics that end inside the track fit, ones that outrun it do not", () => {
		expect(lyricsFitDuration(parsed, 110)).toBe(true);
		expect(lyricsFitDuration(parsed, 60)).toBe(false);
		expect(lyricsFitDuration(parsed, undefined)).toBe(true);
	});
});
