import { describe, expect, test } from "bun:test";
import { hasLyrics, lyricsEndMs, lyricsSyncType, parseLrc, parsePlain, parseQrc, parseTtml, type Lyric } from "../../server/utils/lyrics/parse";
import { qrcHeader } from "../../server/utils/lyrics/qrcHeader";

// Nafyn does not parse lyrics itself any more (@braccato/parsers does): these pin what Nafyn relies on from it -
// the shape the API sends, "nothing usable" as null, the songwriters, and the sync type the renderer will pick.

const QRC = [
	"[ti:Blinding Lights]",
	"[ar:The Weeknd]",
	"[al:After Hours]",
	"[by:]",
	"[offset:0]",
	"[0,4690]Blinding(0,521) (521,521)Lights(1042,521) (1563,521)-(2084,521) (2605,521)The(3126,521) (3647,521)Weeknd(4168,521)",
	"[4690,4690]Lyrics(4690,142) (4832,142)by(4974,142)：(5116,142)Max(5258,142) (5400,142)Martin(5542,142)",
	"[9380,3000]I (9380,300)been (9680,400)tryna (10080,500)call(10580,600)",
	"[12400,3000]Alex：(12400,100)Hi (12500,500)there(13000,0)",
	"[15400,2000]Still (15400,500)Alex(15900,500)",
].join("\n");

const sung = (lyrics: Lyric[]) => lyrics.filter((line) => !line.isInstrumental);

describe("QRC", () => {
	const parsed = parseQrc(QRC, 20_000, { title: "Blinding Lights", artist: "The Weeknd" })!;

	test("drops header tags, credit lines and the restated title", () => {
		expect(sung(parsed.lyrics).map((line) => line.words.trim())).toEqual(["I been tryna call", "Hi there", "Still Alex"]);
	});

	test("words keep absolute times in milliseconds", () => {
		const first = sung(parsed.lyrics)[0]!;
		expect(first.startTimeMs).toBe(9380);
		expect(first.parts!.map((part) => [part.words.trim(), part.startTimeMs, part.durationMs])).toEqual([
			["I", 9380, 300],
			["been", 9680, 400],
			["tryna", 10080, 500],
			["call", 10580, 600],
		]);
		expect(lyricsSyncType(parsed.lyrics)).toBe("richsync");
	});

	test("the credit lines name the songwriters", () => {
		expect(parsed.songwriters).toEqual(["Max Martin"]);
	});

	test("reads the header out of the QQ envelope, quotes and entities included", () => {
		const envelope = `<?xml version="1.0" encoding="utf-8"?>\n<QrcInfos>\n<QrcHeadInfo SaveTime="1" Version="100"/>\n<LyricInfo LyricCount="1">\n<Lyric_1 LyricType="1" LyricContent="[ti:Song]\n[ar:Band]\n[0,2000]Say (0,500)"hi" &amp; (500,500)bye(1000,1000)\n"/>\n</LyricInfo>\n</QrcInfos>`;
		expect(qrcHeader(envelope)).toEqual({ title: "Song", artist: "Band" });
		expect(qrcHeader(QRC)).toEqual({ title: "Blinding Lights", artist: "The Weeknd", album: "After Hours" });
	});

	test("nothing timed is null", () => {
		expect(parseQrc("[ti:Only a header]", 1000)).toBeNull();
		expect(parseQrc("", 1000)).toBeNull();
	});
});

describe("TTML", () => {
	const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><head><metadata><ttm:agent type="person" xml:id="v1"/><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations/><songwriters><songwriter>Abel</songwriter></songwriters><transliterations><transliteration xml:lang="ja-Latn"><text for="L1"><span begin="00:01.000" end="00:02.000">ghost</span></text></transliteration></transliterations></iTunesMetadata></metadata></head><body><div><p begin="00:05.000" end="00:07.000" ttm:agent="v1"><span begin="00:05.000" end="00:06.000">Hello </span><span begin="00:06.000" end="00:07.000">world</span><span ttm:role="x-bg"><span begin="00:06.500" end="00:07.000">(yeah)</span></span></p></div></body></tt>`;
	const parsed = parseTtml(ttml, 10_000)!;

	test("word-timed lines parse without the side data leaking in", () => {
		const lines = sung(parsed.lyrics);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.words).not.toContain("ghost");
		expect(lines[0]!.parts!.filter((part) => !part.isBackground && part.words.trim()).map((part) => part.words.trim())).toEqual(["Hello", "world"]);
	});

	test("background vocals are parts of their line, flagged", () => {
		expect(sung(parsed.lyrics)[0]!.parts!.some((part) => part.isBackground && part.words.includes("yeah"))).toBe(true);
	});

	test("the songwriters come from the metadata", () => {
		expect(parsed.songwriters).toEqual(["Abel"]);
	});

	test("the lyrics end with their last sung part; instrumental lines are not lyrics", () => {
		expect(lyricsEndMs(parsed.lyrics)).toBe(7000);
		const outro: Lyric = { startTimeMs: 7000, durationMs: 60_000, words: "", isInstrumental: true };
		expect(lyricsEndMs([...parsed.lyrics, outro])).toBe(7000);
	});

	test("an unparseable document is null, not a throw", () => {
		expect(parseTtml("<tt><broken", 1000)).toBeNull();
	});
});

describe("LRC and plain text", () => {
	test("LRC lines are synced", () => {
		const parsed = parseLrc("[00:01.00]first\n[00:04.50]second\n", 10_000)!;
		expect(sung(parsed.lyrics).map((line) => [line.words, line.startTimeMs])).toEqual([["first", 1000], ["second", 4500]]);
		expect(lyricsSyncType(parsed.lyrics)).toBe("synced");
	});

	test("plain text is unsynced, blank lines are not lyrics", () => {
		const parsed = parsePlain("a\nb\n\nc")!;
		expect(lyricsSyncType(parsed.lyrics)).toBe("none");
		expect(parsed.lyrics.filter((line) => line.words).map((line) => line.words)).toEqual(["a", "b", "c"]);
		expect(lyricsEndMs(parsed.lyrics)).toBe(0);
	});

	test("blank input is null", () => {
		expect(parsePlain("\n \n")).toBeNull();
		expect(parseLrc("[00:01.00]\n", 1000)).toBeNull();
		expect(hasLyrics([])).toBe(false);
	});
});
