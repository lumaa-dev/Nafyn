import { describe, expect, test } from "bun:test";
import { convert, FileFormat, parseQRC, qrcHeader, stripTtmlSideData, TTMLParser } from "../../server/utils/lyrics/parser";

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

const lines = (paragraphs: NonNullable<ReturnType<typeof parseQRC>>) => paragraphs.flatMap((p) => p.lines);

describe("parseQRC", () => {
	test("drops header tags, credit lines and the restated title", () => {
		const parsed = parseQRC(QRC)!;
		expect(lines(parsed).map((line) => line.text)).toEqual(["I been tryna call", "Hi there", "Still Alex"]);
	});

	test("words keep absolute times in seconds and endsWord from the source spacing", () => {
		const first = lines(parseQRC(QRC)!)[0]!;
		expect(first.startTime).toBe(9.38);
		expect(first.segments.map((s) => [s.text, s.startTime, s.endTime, s.endsWord])).toEqual([
			["I", 9.38, 9.68, true],
			["been", 9.68, 10.08, true],
			["tryna", 10.08, 10.58, true],
			["call", 10.58, 11.18, true],
		]);
	});

	test("a full-width colon opens a singer; an ASCII colon stays lyrics", () => {
		const parsed = lines(parseQRC(QRC)!);
		expect(parsed.map((l) => l.type.alt)).toEqual([false, true, true]);

		const sentence = parseQRC("[0,2000]I'll tell you why: (0,1000)because(1000,1000)")!;
		expect(lines(sentence)[0]!.text).toBe("I'll tell you why: because");
	});

	test("a zero-length word lasts until the next word, or the line's end", () => {
		const hi = lines(parseQRC(QRC)!)[1]!;
		expect(hi.segments.at(-1)!.endTime).toBe(15.4);
	});

	test("CJK words without spaces join without spaces", () => {
		const parsed = parseQRC("[0,1000]你(0,300)好(300,300)世(600,200)界(800,200)")!;
		expect(lines(parsed)[0]!.text).toBe("你好世界");
	});

	test("reads the body out of the QQ envelope, quotes and entities included", () => {
		const envelope = `<?xml version="1.0" encoding="utf-8"?>\n<QrcInfos>\n<QrcHeadInfo SaveTime="1" Version="100"/>\n<LyricInfo LyricCount="1">\n<Lyric_1 LyricType="1" LyricContent="[ti:Song]\n[ar:Band]\n[0,2000]Say (0,500)"hi" &amp; (500,500)bye(1000,1000)\n"/>\n</LyricInfo>\n</QrcInfos>`;
		expect(qrcHeader(envelope)).toEqual({ title: "Song", artist: "Band" });
		expect(lines(parseQRC(envelope)!)[0]!.text).toBe('Say "hi" & bye');
	});

	test("nothing timed is null", () => {
		expect(parseQRC("[ti:Only a header]")).toBeNull();
		expect(parseQRC("")).toBeNull();
	});

	test("the result exports through convert() like any other format", () => {
		const parsed = parseQRC(QRC)!;
		expect(convert(parsed, FileFormat.LRC)).toContain("[00:09.38] I been tryna call");
		expect(convert(parsed, FileFormat.SRT)).toContain("00:00:09,380 --> 00:00:12,380");
		expect(convert(parsed, FileFormat.TTML)).toContain('<span begin="00:09.380" end="00:09.680">I</span>');
	});
});

describe("TTML from Better Lyrics", () => {
	const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"><head><metadata><ttm:agent type="person" xml:id="v1"/><iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations/><songwriters><songwriter>Abel</songwriter></songwriters><transliterations><transliteration xml:lang="ja-Latn"><text for="L1"><span begin="00:01.000" end="00:02.000">ghost</span></text></transliteration></transliterations></iTunesMetadata></metadata></head><body><div><p begin="00:05.000" end="00:07.000" ttm:agent="v1"><span begin="00:05.000" end="00:06.000">Hello </span><span begin="00:06.000" end="00:07.000">world</span></p></div></body></tt>`;

	test("side data is stripped", () => {
		expect(stripTtmlSideData(ttml)).not.toContain("ghost");
	});

	test("word-timed lines parse without the side data leaking in", () => {
		const parsed = new TTMLParser(ttml).parse()!;
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.lines[0]!.text).toBe("Hello world");
		expect(parsed[0]!.lines[0]!.segments).toHaveLength(2);
	});
});
