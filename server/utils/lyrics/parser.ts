// ---------------------------------------------------------------------------
// Core data model
// ---------------------------------------------------------------------------

import { fetchAllLyrics, type StudioLyricResponse } from "./cider";

export interface LyricSegment {
	id: string;
	text: string;
	startTime: number;
	endTime: number;
	/** Whether this segment ends a word (vs. being a mid-word fragment). */
	endsWord: boolean;
}

/**
 * Swift's `LineType` enum-with-associated-value (`main(Bool)` / `background(Bool)`)
 * becomes a discriminated union, with the `Bool` payload renamed `alt`
 * (it represented "alt voice", i.e. an odd `ttm:agent` number).
 */
export type LineType =
	| { kind: "main"; alt: boolean }
	| { kind: "background"; alt: boolean };

export function lineTypeIsAlt(type: LineType): boolean {
	return type.alt;
}

export function lineTypeIsBackground(type: LineType): boolean {
	return type.kind === "background";
}

export function lineTypeEquals(a: LineType, b: LineType): boolean {
	return a.kind === b.kind && a.alt === b.alt;
}

export interface LyricLine {
	id: string;
	text: string;
	startTime: number;
	endTime: number;
	type: LineType;
	segments: LyricSegment[];
}

export interface LyricParagraph {
	id: string;
	lines: LyricLine[];
}

export type LyricParagraphs = LyricParagraph[];

export enum Provider {
	/** Lyrics a Nafyn user wrote or pasted in themselves; they override every fetched provider. */
	Manual = "manual",
	BetterLyrics = "betterLyrics",
	Unison = "unison",
	Cider = "cider",
	Lrclib = "lrclib",
	Cache = "cache",
}

export function providerLocalized(provider: Provider): string {
	switch (provider) {
		case Provider.Manual:
			return "Nafyn";
		case Provider.BetterLyrics:
			return "Better Lyrics";
		case Provider.Unison:
			return "Unison";
		case Provider.Cider:
			return "Cider Lyrics Studio";
		case Provider.Lrclib:
			return "LRCLIB";
		case Provider.Cache:
			// Swift used `String(localized: "cache")`. Route this string
			// through your own i18n system if you have one.
			return "cache";
	}
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/**
 * Referenced via `globalThis` (rather than the bare `crypto` / `console`
 * identifiers) so this file type-checks and runs correctly regardless of
 * which `lib` a consuming project's tsconfig sets — no dependency on
 * `lib.dom` or `@types/node` ambient declarations either way. Both
 * `crypto` and `console` are real runtime globals in browsers, in Nuxt's
 * client bundle, and in Nitro's Node server runtime.
 */
const globalScope = globalThis as unknown as {
	crypto?: { randomUUID?: () => string };
	console: Console;
};

interface Console {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

function uuid(): string {
	const cryptoObj = globalScope.crypto;
	if (cryptoObj?.randomUUID) {
		// Called as `cryptoObj.randomUUID()`, not via a detached reference,
		// since some runtimes' `randomUUID` requires `this` to be the
		// original Crypto object.
		return cryptoObj.randomUUID();
	}
	// Minimal RFC4122-ish fallback for environments without crypto.randomUUID.
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function log(...args: unknown[]): void {
	globalScope.console.log(...args);
}

function logError(...args: unknown[]): void {
	globalScope.console.error(...args);
}

function pad(n: number, width: number = 2): string {
	return Math.trunc(n).toString().padStart(width, "0");
}

/** Trims whitespace, and unwraps a single layer of "(...)" if present. */
function lyricTrim(input: string): string {
	let result = input.trim();
	if (result.length > 1 && result.startsWith("(") && result.endsWith(")")) {
		result = result.slice(1, -1);
	}
	return result;
}

/**
 * Parses a TTML timestamp ("hh:mm:ss.mmm", "mm:ss.mmm", or "ss.mmm") into
 * seconds. Faithfully mirrors the original Swift `parseTime`, including
 * treating the text after the decimal point as a literal millisecond
 * count (not a decimal fraction) before dividing by 1000.
 */
function parseTime(timeString: string): number {
	let timestamp = 0;

	if (timeString.includes(":")) {
		const components = timeString.split(":");
		const hours = components.length === 3 ? Number(components[0]) || 0 : 0;
		const minutes =
			components.length === 3
				? Number(components[1]) || 0
				: Number(components[0]) || 0;
		const secondsString = components[components.length - 1];
		const secParts = secondsString.split(".");
		const seconds = Number(secParts[0]) || 0;
		const milliseconds = secParts.length > 1 ? Number(secParts[1]) || 0 : 0;
		timestamp = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
	} else {
		const parts = timeString.split(".");
		const seconds = Number(parts[0]) || 0;
		const milliseconds = parts.length > 1 ? Number(parts[1]) || 0 : 0;
		timestamp = seconds + milliseconds / 1000;
	}

	return timestamp;
}

/** "mm:ss.mmm" formatter used by TTML export. */
function formatTtmlTime(seconds: number): string {
	const milli = Math.round((seconds % 1) * 1000);
	const total = Math.floor(seconds);
	const mins = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return `${pad(mins)}:${pad(secs)}.${pad(milli, 3)}`;
}

/** "hh:mm:ss,mmm" formatter used by SRT export. */
function formatSrtTime(seconds: number): string {
	const milli = Math.round((seconds % 1) * 1000);
	const total = Math.floor(seconds);
	const hrs = Math.floor(total / 3600);
	const mins = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(milli, 3)}`;
}

/**
 * Flattens a run of word-by-word segments into display text, inserting a
 * space only where `endsWord` says the source actually had one. This
 * matters for lines like "you're" or "animal" that TTML
 * sometimes splits into adjacent, whitespace-less spans (e.g. "you'" +
 * "re") purely to drive word-by-word highlighting timing — naively
 * joining every segment with a space would wrongly render "you' re".
 */
function joinSegments(segments: LyricSegment[]): string {
	let out = "";
	for (const seg of segments) {
		out += seg.text;
		if (seg.endsWord) out += " ";
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// LyricLine factory (ports LyricLine's custom `init`)
// ---------------------------------------------------------------------------

/**
 * Builds a `LyricLine`. If every segment is wrapped as a whole in a single
 * pair of parentheses (first segment starts with "(", last segment ends
 * with ")"), the parentheses are stripped from both the flattened `text`
 * and the first/last segment text — mirroring the Swift initializer.
 */
export function createLyricLine(
	text: string,
	startTime: number,
	endTime: number,
	type: LineType,
	segments: LyricSegment[] = [],
): LyricLine {
	let newText = text;
	const newSeg = segments.map((s) => ({ ...s }));

	const firstText = newSeg[0]?.text;
	const lastText = newSeg[newSeg.length - 1]?.text;

	if (firstText?.[0] === "(" && lastText?.[lastText.length - 1] === ")") {
		newText = lyricTrim(newText);
		newSeg[0] = { ...newSeg[0], text: newSeg[0].text.slice(1) };
		const lastIdx = newSeg.length - 1;
		newSeg[lastIdx] = {
			...newSeg[lastIdx],
			text: newSeg[lastIdx].text.slice(0, -1),
		};
	}

	return {
		id: uuid(),
		text: newText,
		startTime,
		endTime,
		type,
		segments: newSeg,
	};
}

// ---------------------------------------------------------------------------
// Export: TTML / SRT / LRC per-line & per-paragraph rendering
// ---------------------------------------------------------------------------

export function lineToTtml(line: LyricLine): string {
	let total = "";
	for (const segment of line.segments) {
		total += `<span begin="${formatTtmlTime(segment.startTime)}" end="${formatTtmlTime(
			segment.endTime,
		)}">${segment.text}</span>`;
	}
	return total;
}

export function lineToSrt(line: LyricLine, index: number): string {
	return [
		`${index}`,
		`${formatSrtTime(line.startTime)} --> ${formatSrtTime(line.endTime)}`,
		line.text,
	].join("\n");
}

export function lineToLrc(line: LyricLine): string {
	// Note: LRC timestamps use 2-digit centiseconds, not milliseconds.
	const centi = Math.round((line.startTime % 1) * 100);
	const total = Math.floor(line.startTime);
	const mins = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return `[${pad(mins)}:${pad(secs)}.${pad(centi)}] ${line.text}`;
}

export function paragraphToTtml(paragraph: LyricParagraph): string {
	let final = "";
	for (const line of paragraph.lines) {
		const firstSeg = line.segments[0];
		const lastSeg = line.segments[line.segments.length - 1];
		if (!firstSeg || !lastSeg) continue;

		final += `<p begin="${formatTtmlTime(firstSeg.startTime)}" end="${formatTtmlTime(
			lastSeg.endTime,
		)}">${lineToTtml(line)}</p>`;
	}
	return final;
}

// ---------------------------------------------------------------------------
// LyricParagraphs "extension" helpers
// ---------------------------------------------------------------------------

export function isStatic(paragraphs: LyricParagraphs): boolean {
	if (paragraphs.length === 0) return true;

	const times: number[] = [];
	for (const p of paragraphs) {
		for (const l of p.lines) {
			times.push(l.startTime);
		}
	}

	return times.length > 0 ? times[times.length - 1] <= 0.0 : true;
}

export function isBeatByBeat(paragraphs: LyricParagraphs): boolean {
	if (paragraphs.length === 0) return false;
	if (paragraphs[0].lines.length === 0) return false;

	const segments = paragraphs[0].lines[0].segments;
	return segments.length > 0;
}

export enum FileFormat {
	SRT = "srt",
	LRC = "lrc",
	TTML = "ttml",
}

/** MIME/UTType-ish helper; wire this up to your own type identifiers. */
export function fileFormatExtension(format: FileFormat): string {
	switch (format) {
		case FileFormat.SRT:
			return "srt";
		case FileFormat.LRC:
			return "lrc";
		case FileFormat.TTML:
			return "ttml";
	}
}

function wrapFormat(
	format: FileFormat,
	content: string,
	hasAlt: boolean = false,
): string {
	switch (format) {
		case FileFormat.TTML: {
			const altTag = hasAlt ? `<ttm:agent type="other" xml:id="v2"/>` : "";
			return (
				`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ` +
				`xmlns:amll="http://www.example.com/ns/amll" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" ` +
				`itunes:timing="Word"><head><metadata><ttm:agent type="person" xml:id="v1"/>${altTag}</metadata></head>${content}</tt>`
			);
		}
		default:
			return content;
	}
}

/** Converts parsed lyric paragraphs into a complete TTML, SRT, or LRC file. */
export function convert(
	paragraphs: LyricParagraphs,
	format: FileFormat,
): string {
	let finalExport = "";
	let idx = 1;

	for (const paragraph of paragraphs) {
		if (format === FileFormat.TTML) {
			const ttml = paragraphToTtml(paragraph);
			const firstLine = paragraph.lines[0];
			const lastLine = paragraph.lines[paragraph.lines.length - 1];
			if (firstLine && lastLine) {
				finalExport += `<body dur="${lastLine.endTime}"><div start="${firstLine.startTime}" end="${lastLine.endTime}">`;
			}
			finalExport += `${ttml}</div></body>`;
		} else {
			for (const line of paragraph.lines) {
				switch (format) {
					case FileFormat.SRT:
						finalExport += lineToSrt(line, idx) + "\n";
						idx += 1;
						break;
					case FileFormat.LRC:
						finalExport += lineToLrc(line);
						break;
					default:
						continue;
				}
				finalExport += "\n";
			}
		}
	}

	const hasAlt =
		isBeatByBeat(paragraphs) &&
		paragraphs.some(
			(p) =>
				p.lines.filter(
					(l) =>
						(l.type.kind === "main" || l.type.kind === "background") &&
						l.type.alt === true,
				).length > 0,
		);

	return wrapFormat(format, finalExport, hasAlt);
}

// ---------------------------------------------------------------------------
// Minimal SAX-style XML tokenizer (no DOM dependency)
// ---------------------------------------------------------------------------
//
// TTML from Better Lyrics / Unison / Cider Lyrics Studio is well-formed, simple XML:
// no nested CDATA-heavy content, no unusual namespaces beyond qualified
// attribute/element names like `ttm:agent`. That makes a small hand-rolled
// tokenizer entirely sufficient, and it avoids pulling in a full XML
// library (and avoids `DOMParser`/`Document`/`Element`/`Node`, which don't
// exist in Nitro's server runtime).
//
// The tokenizer emits the same three SAX-style events the original Swift
// `XMLParserDelegate` used, in document order:
//   onStartElement(name, attrs, selfClosing)
//   onText(text)
//   onEndElement(name)

interface XmlTokenHandler {
	onStartElement: (
		name: string,
		attrs: Record<string, string>,
		selfClosing: boolean,
	) => void;
	onEndElement: (name: string) => void;
	onText: (text: string) => void;
}

/** Decodes the standard XML entities plus numeric character references. */
function decodeXmlEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
			String.fromCodePoint(parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, dec: string) =>
			String.fromCodePoint(parseInt(dec, 10)),
		)
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

/** Finds the index of the `>` that closes a tag opened at `start`, respecting quoted attribute values. */
function findTagEnd(xml: string, start: number): number {
	let i = start + 1;
	let inQuote: string | null = null;
	while (i < xml.length) {
		const c = xml[i];
		if (inQuote) {
			if (c === inQuote) inQuote = null;
		} else if (c === '"' || c === "'") {
			inQuote = c;
		} else if (c === ">") {
			return i;
		}
		i++;
	}
	return xml.length;
}

const ATTR_RE = /([a-zA-Z_:][\w:.\-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Parses `name attr1="a" attr2='b'` (the inside of a tag, minus the trailing `/`). */
function parseTagContent(tagContent: string): {
	name: string;
	attrs: Record<string, string>;
} {
	const trimmed = tagContent.trim();
	const spaceIdx = trimmed.search(/\s/);
	const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	const attrs: Record<string, string> = {};

	if (spaceIdx !== -1) {
		const attrStr = trimmed.slice(spaceIdx);
		ATTR_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = ATTR_RE.exec(attrStr)) !== null) {
			const attrName = m[1];
			const attrValue = m[3] !== undefined ? m[3] : m[4];
			attrs[attrName] = decodeXmlEntities(attrValue ?? "");
		}
	}

	return { name, attrs };
}

/**
 * Streams SAX-style start/text/end events over a raw XML string, in
 * document order — a drop-in replacement for what `Foundation.XMLParser`
 * gave the original Swift delegate, minus any DOM tree in between.
 */
function parseXML(xml: string, handler: XmlTokenHandler): void {
	const len = xml.length;
	let i = 0;

	while (i < len) {
		if (xml[i] === "<") {
			if (xml.startsWith("<!--", i)) {
				const end = xml.indexOf("-->", i + 4);
				i = end === -1 ? len : end + 3;
				continue;
			}
			if (xml.startsWith("<![CDATA[", i)) {
				const end = xml.indexOf("]]>", i + 9);
				const content = end === -1 ? xml.slice(i + 9) : xml.slice(i + 9, end);
				if (content.length > 0) handler.onText(content);
				i = end === -1 ? len : end + 3;
				continue;
			}
			if (xml.startsWith("<?", i)) {
				const end = xml.indexOf("?>", i + 2);
				i = end === -1 ? len : end + 2;
				continue;
			}
			if (xml.startsWith("<!", i)) {
				// DOCTYPE or other markup declaration.
				const end = xml.indexOf(">", i + 2);
				i = end === -1 ? len : end + 1;
				continue;
			}
			if (xml[i + 1] === "/") {
				const end = xml.indexOf(">", i + 2);
				const name = xml.slice(i + 2, end === -1 ? len : end).trim();
				handler.onEndElement(name);
				i = end === -1 ? len : end + 1;
				continue;
			}

			const end = findTagEnd(xml, i);
			let tagContent = xml.slice(i + 1, end);
			let selfClosing = false;
			if (tagContent.endsWith("/")) {
				selfClosing = true;
				tagContent = tagContent.slice(0, -1);
			}

			const { name, attrs } = parseTagContent(tagContent);
			handler.onStartElement(name, attrs, selfClosing);
			if (selfClosing) {
				handler.onEndElement(name);
			}

			i = end + 1;
			continue;
		}

		const nextLt = xml.indexOf("<", i);
		const textEnd = nextLt === -1 ? len : nextLt;
		const raw = xml.slice(i, textEnd);
		if (raw.length > 0) {
			handler.onText(decodeXmlEntities(raw));
		}
		i = textEnd;
	}
}

// ---------------------------------------------------------------------------
// Parser (ports the SAX-based `Parser: NSObject, XMLParserDelegate`)
// ---------------------------------------------------------------------------

/**
 * Drops what TTML carries beside the lyrics - songwriter lists, translations, transliterations. They hold `<span>`s
 * and text of their own that the line parser would otherwise take for the first line's words.
 */
export function stripTtmlSideData(ttml: string): string {
	return ttml
		.replace(/<(?:\w+:)?iTunesMetadata\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?iTunesMetadata>)/gi, "")
		.replace(/<(transliterations|translations)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/gi, "");
}

/**
 * Parses TTML lyrics (word-by-word "beat-by-beat", line-synced, or legacy
 * paragraph-based; Better Lyrics, Unison and Cider Lyrics Studio all send it)
 * into `LyricParagraphs`.
 *
 * No DOM dependency — safe to call from Nuxt components, composables, or
 * Nitro server routes alike.
 */
export class TTMLParser {
	private ttml: string;
	private paragraphs: LyricParagraph[] = [];

	// "p" element state
	private currentText = "";
	private currentBegin: string | null = null;
	private currentEnd: string | null = null;
	private currentAgent: string | null = null;

	// "span" element state
	private sawSpan = false;
	private isInBg = false;
	private prevIsInBg = false;
	private currentSegments: LyricSegment[] = [];
	private currentBgSegments: LyricSegment[] = [];
	private currentSegmentText = "";
	private currentSegmentBegin: string | null = null;
	private currentSegmentEnd: string | null = null;

	constructor(ttml: string) {
		this.ttml = ttml;
	}

	parse(): LyricParagraphs | null {
		this.resetVars();
		this.paragraphs = [];

		try {
			parseXML(stripTtmlSideData(this.ttml), {
				onStartElement: (name, attrs, selfClosing) => {
					this.didStartElement(name, attrs);
					if (selfClosing) {
						// A self-closing element (e.g. <ttm:agent .../>) is
						// equivalent to an immediate start+end with no children —
						// the same thing a DOM walk over it would produce.
						this.didEndElement(name);
					}
				},
				onEndElement: (name) => this.didEndElement(name),
				onText: (text) => this.foundCharacters(text),
			});
		} catch (e) {
			logError("[TTMLParser] Failed to parse XML:", e);
			return null;
		}

		log("[TTMLParser] Parsed lyrics");
		return this.paragraphs;
	}

	private didStartElement(
		elementName: string,
		attrs: Record<string, string>,
	): void {
		if (elementName === "p") {
			this.currentBegin = attrs["begin"] ?? null;
			this.currentEnd = attrs["end"] ?? null;
			this.currentAgent = attrs["ttm:agent"] ?? null;
			this.currentText = "";
			this.sawSpan = false;
			this.currentSegments = [];
			this.currentBgSegments = [];
		} else if (elementName === "span") {
			this.sawSpan = true;

			if (attrs["ttm:role"] === "x-bg") {
				this.isInBg = true;
				this.currentBgSegments = [];
			}

			if (this.prevIsInBg !== this.isInBg) {
				const segment = this.createSegment();
				if (segment) {
					this.isInBg = this.prevIsInBg;
					this.finalizeSegment(segment, true);
					this.isInBg = !this.prevIsInBg;
				}
			}

			if (
				this.currentSegmentBegin !== null &&
				this.currentSegmentEnd !== null &&
				this.currentSegmentText !== ""
			) {
				const segment = this.createSegment();
				if (segment) {
					const endsWord = this.segmentTextEndsWord(this.currentSegmentText);
					this.finalizeSegment(segment, endsWord);
				}
			}

			this.currentSegmentBegin = attrs["begin"] ?? null;
			this.currentSegmentEnd = attrs["end"] ?? null;
		}
	}

	private foundCharacters(text: string): void {
		if (text.length === 0) return;

		// Whitespace-only text (including plain word-boundary spaces between
		// <span> elements) marks the end of the current segment, if any.
		if (text.trim().length === 0) {
			const segment = this.createSegment();
			if (segment) {
				this.finalizeSegment(segment, true);
			}
			return;
		}

		if (this.sawSpan) {
			this.prevIsInBg = this.isInBg;
			this.currentSegmentText += text;
		} else {
			this.currentText += text;
		}
	}

	private didEndElement(elementName: string): void {
		if (elementName === "p") {
			let trimmedText: string;
			let segments: LyricSegment[] = [];

			if (this.sawSpan) {
				if (
					this.currentSegmentBegin !== null &&
					this.currentSegmentEnd !== null &&
					this.currentSegmentText !== ""
				) {
					const segment = this.createSegment();
					if (segment) {
						this.finalizeSegment(segment, true);
					}
				}

				trimmedText = joinSegments(this.currentSegments);
				segments = this.currentSegments;
			} else {
				trimmedText = this.currentText;
			}

			trimmedText = trimmedText.trim();

			let start = 0.0;
			let end = 0.0;
			if (this.currentBegin !== null && this.currentEnd !== null) {
				start = parseTime(this.currentBegin);
				end = parseTime(this.currentEnd);
			}

			const agentNum = this.currentAgent
				? parseInt(this.currentAgent.replace(/v/g, ""), 10)
				: 1;
			const altVoice = (Number.isNaN(agentNum) ? 1 : agentNum) % 2 === 0;

			const mainLine = createLyricLine(
				trimmedText,
				start,
				end,
				{ kind: "main", alt: altVoice },
				segments,
			);
			const lines: LyricLine[] = [mainLine];

			if (this.currentBgSegments.length > 0) {
				const bgText = joinSegments(this.currentBgSegments);
				const bgStart = this.currentBgSegments[0]?.startTime ?? start;
				const bgEnd =
					this.currentBgSegments[this.currentBgSegments.length - 1]
						?.endTime ?? end;
				const bgLine = createLyricLine(
					bgText,
					bgStart,
					bgEnd,
					{ kind: "background", alt: altVoice },
					this.currentBgSegments,
				);
				lines.push(bgLine);
			}

			const paragraph: LyricParagraph = { id: uuid(), lines };
			this.paragraphs.push(paragraph);

			this.resetVars();
		}
	}

	private createSegment(): LyricSegment | null {
		const trimmed = lyricTrim(this.currentSegmentText);
		if (
			trimmed.length === 0 ||
			this.currentSegmentBegin === null ||
			this.currentSegmentEnd === null
		) {
			return null;
		}

		const start = parseTime(this.currentSegmentBegin);
		const end = parseTime(this.currentSegmentEnd);

		return {
			id: uuid(),
			text: trimmed,
			startTime: start,
			endTime: end,
			endsWord: true,
		};
	}

	private segmentTextEndsWord(text: string): boolean {
		const last = text[text.length - 1];
		return last !== undefined && /\s/.test(last);
	}

	private finalizeSegment(
		segment: LyricSegment,
		endsWord: boolean = true,
	): void {
		const finalized: LyricSegment = { ...segment, endsWord };

		if (this.isInBg) {
			this.currentBgSegments.push(finalized);
		} else {
			this.currentSegments.push(finalized);
		}

		this.currentSegmentBegin = null;
		this.currentSegmentEnd = null;
		this.currentSegmentText = "";
	}

	/**
	 * NOTE: intentionally mirrors the original Swift `resetVars()`, which
	 * does NOT reset `currentSegmentBegin` / `currentSegmentEnd` /
	 * `currentSegmentText`. Kept as-is for behavioral parity.
	 */
	private resetVars(): void {
		this.currentBegin = null;
		this.currentEnd = null;
		this.currentAgent = null;
		this.currentText = "";
		this.sawSpan = false;
		this.isInBg = false;
		this.currentSegments = [];
		this.currentBgSegments = [];
	}
}

// ---------------------------------------------------------------------------
// QRC (word-timed karaoke lyrics, as sent by Better Lyrics' QQ provider)
//
// Spec: https://docs.betterlyrics.org/docs/qrc-format
//
//   [ti:Title]  [ar:Artist]  [al:Album]  [by:]  [offset:0]        <- header tags, no lyrics
//   [1000,1200]Sample (1000,300)line (1300,400)here(1700,500)      <- [lineStartMs,lineDurationMs] then
//                                                                     each word followed by (startMs,durationMs)
//
// Word times are absolute (from the start of the song). The result is the same model the TTML parser builds -
// a paragraph per line, segments per word, `endsWord` from the whitespace the source had - so it exports
// through `convert()` (TTML / SRT / LRC) and plays through the same panel as every other format.
// ---------------------------------------------------------------------------

/** Credit labels QRC files time like lyrics ("Lyrics by：Max Martin"); such lines are not part of the song. */
const QRC_CREDIT_RE = new RegExp(
	"^\\s*(?:" +
		[
			"lyrics?\\s+by", "lyricist", "written\\s+by", "words\\s+by", "music\\s+by", "composed\\s+by", "composer",
			"arranged\\s+by", "arranger", "produced\\s+by", "producer", "co-producer", "executive\\s+producer",
			"mixed\\s+by", "mixing(?:\\s+engineer)?", "mastered\\s+by", "mastering(?:\\s+engineer)?",
			"recorded\\s+by", "recording(?:\\s+engineer)?", "engineer(?:ed\\s+by)?", "programming", "published\\s+by",
			"publisher", "vocals?", "background\\s+vocals?", "guitars?", "bass", "drums", "piano", "keyboards?",
			"strings", "chorus", "op", "sp", "isrc", "original\\s+publisher", "sub-publisher",
			"作词", "作詞", "作曲", "编曲", "編曲", "制作人", "製作人", "监制", "監製", "混音", "母带", "母帶", "录音", "錄音",
			"和声", "和聲", "吉他", "贝斯", "貝斯", "鼓", "钢琴", "鋼琴", "弦乐", "弦樂", "出品", "发行", "發行", "版权", "版權",
			"词", "詞", "曲", "编", "編", "演唱", "原唱", "歌手",
		].join("|") +
		")\\s*[:：]",
	"i",
);

export interface ParseQrcOptions {
	/** The track's title/artist; also read from the `[ti:]` / `[ar:]` header tags when not given. */
	title?: string;
	artist?: string;
	/** The track's length in milliseconds - the end of the last line when QRC gives it a duration of 0. */
	durationMs?: number;
}

/** Pulls the QRC body out of the QQ provider's XML envelope; a bare QRC body is returned as is. */
export function extractQrcBody(input: string): string {
	if (!/<\s*(?:QrcInfos|LyricInfo|Lyric_\d+)\b/i.test(input)) return input;

	// the attribute value can hold raw `"` (lyrics with quotes), so it ends at the first `"/>`, not the first `"`
	const match = /LyricContent="([\s\S]*?)"\s*\/>/.exec(input);
	return match ? decodeXmlEntities(match[1]!) : "";
}

/** The `[ti:]` / `[ar:]` / `[al:]` header tags of a QRC file (empty ones are left out). */
export function qrcHeader(input: string): { title?: string; artist?: string; album?: string } {
	const result: { title?: string; artist?: string; album?: string } = {};
	for (const raw of extractQrcBody(input).split(/\r?\n/)) {
		const match = /^\s*\[(ti|ar|al):(.*)\]\s*$/i.exec(raw);
		const value = match?.[2]?.trim();
		if (!match || !value) continue;
		const key = ({ ti: "title", ar: "artist", al: "album" } as const)[match[1]!.toLowerCase() as "ti" | "ar" | "al"];
		result[key] ??= value;
	}
	return result;
}

function foldQrcText(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Parses QRC lyrics into `LyricParagraphs`, or `null` when the text holds no timed line at all.
 *
 * Dropped, as the spec asks: header tags, credit lines ("Lyrics by：…", 作词 …) and the opening lines that only
 * repeat the title / artist. A leading "Name：" (full-width colon) is a singer, not lyrics: it is cut from the
 * text and the lines under it, up to the next prefix, get that singer - the second singer to appear is the
 * "alt" voice, like an even `ttm:agent` in TTML.
 */
export function parseQRC(input: string, options: ParseQrcOptions = {}): LyricParagraphs | null {
	const body = extractQrcBody(input);

	let title = options.title ?? "";
	let artist = options.artist ?? "";
	interface RawLine { start: number; duration: number; words: { text: string; start: number; duration: number }[] }
	const rawLines: RawLine[] = [];

	for (const raw of body.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0) continue;

		const header = /^\[([a-zA-Z]+):(.*)\]$/.exec(line);
		if (header) {
			const value = header[2]!.trim();
			if (!title && header[1]!.toLowerCase() === "ti") title = value;
			if (!artist && header[1]!.toLowerCase() === "ar") artist = value;
			continue;
		}

		const lineHead = /^\[(\d+),(\d+)\]/.exec(line);
		if (!lineHead) continue;

		// a word's text is everything between the end of the previous token and its own `(start,duration)`
		const words: RawLine["words"] = [];
		const wordRe = /\((\d+),(\d+)\)/g;
		const rest = line.slice(lineHead[0].length);
		let cursor = 0;
		let m: RegExpExecArray | null;
		while ((m = wordRe.exec(rest)) !== null) {
			words.push({ text: rest.slice(cursor, m.index), start: Number(m[1]), duration: Number(m[2]) });
			cursor = m.index + m[0].length;
		}
		// a line without word tokens is a plain timed line: one "word" spanning it
		if (words.length === 0 && rest.trim().length > 0) {
			words.push({ text: rest, start: Number(lineHead[1]), duration: Number(lineHead[2]) });
		}
		if (words.length === 0) continue;

		rawLines.push({ start: Number(lineHead[1]), duration: Number(lineHead[2]), words });
	}

	const foldedTitle = foldQrcText(title);
	const foldedArtist = foldQrcText(artist);
	const isMetadataLine = (text: string): boolean => {
		const folded = foldQrcText(text);
		if (!folded) return false;
		return folded === foldedTitle
			|| (foldedTitle !== "" && foldedArtist !== "" && (folded === `${foldedTitle} ${foldedArtist}` || folded === `${foldedArtist} ${foldedTitle}`));
	};

	const singers: string[] = [];
	let currentSinger = 0;
	const lines: { raw: RawLine; text: string; singer: number; segments: LyricSegment[] }[] = [];
	let sawLyric = false;

	for (const raw of rawLines) {
		let words = raw.words;
		const fullText = words.map((w) => w.text).join("");

		if (QRC_CREDIT_RE.test(fullText)) continue;
		// the title / artist restated at the top - only before the first real line, a chorus can say its own title
		if (!sawLyric && isMetadataLine(fullText.replace(/\s*[-–—]\s*/g, " - "))) continue;

		// "Name：" opens a singer; only the full-width colon, an ASCII one is a sentence ("I'll tell you why: ...")
		const prefix = /^\s*([^:：]{1,24})：\s*/.exec(fullText);
		if (prefix) {
			const name = prefix[1]!.trim();
			let index = singers.indexOf(name);
			if (index < 0) {
				// lines sung before the first named singer belong to an unnamed first voice
				if (singers.length === 0 && lines.length > 0) singers.push("");
				singers.push(name);
				index = singers.length - 1;
			}
			currentSinger = index;

			// drop the words that make up the prefix
			let consumed = 0;
			const kept: typeof words = [];
			for (const word of words) {
				if (consumed >= prefix[0].length) {
					kept.push(word);
				} else if (consumed + word.text.length > prefix[0].length) {
					kept.push({ ...word, text: word.text.slice(prefix[0].length - consumed) });
				}
				consumed += word.text.length;
			}
			words = kept;
			if (words.length === 0) continue;
		}

		const segments: LyricSegment[] = [];
		for (const word of words) {
			const trimmed = word.text.trim();
			if (trimmed.length === 0) {
				// a timed space: it only says the previous word ended there
				if (segments.length > 0) segments[segments.length - 1]!.endsWord = true;
				continue;
			}
			if (/^\s/.test(word.text) && segments.length > 0) segments[segments.length - 1]!.endsWord = true;

			segments.push({
				id: uuid(),
				text: trimmed,
				startTime: word.start / 1000,
				endTime: (word.start + word.duration) / 1000,
				endsWord: /\s$/.test(word.text),
			});
		}
		if (segments.length === 0) continue;
		// like the TTML parser: the line's last word closes the line
		segments[segments.length - 1]!.endsWord = true;

		const text = joinSegments(segments);
		if (text.length === 0) continue;

		sawLyric = true;
		lines.push({ raw, text, singer: currentSinger, segments });
	}

	if (lines.length === 0) return null;

	const paragraphs: LyricParagraphs = [];
	for (let i = 0; i < lines.length; i++) {
		const { raw, text, singer, segments } = lines[i]!;
		const next = lines[i + 1];

		const lineStart = raw.start / 1000;
		// a duration of 0 happens: the line then lasts until the next one starts (the song's end for the last)
		const declaredEnd = raw.duration > 0
			? (raw.start + raw.duration) / 1000
			: next ? next.raw.start / 1000 : options.durationMs ? options.durationMs / 1000 : segments[segments.length - 1]!.endTime;

		// a word with no length of its own lasts until the next word starts (the line's end for the last)
		for (let s = 0; s < segments.length; s++) {
			const seg = segments[s]!;
			if (seg.endTime <= seg.startTime) {
				seg.endTime = Math.max(seg.startTime, segments[s + 1]?.startTime ?? declaredEnd);
			}
		}

		const end = Math.max(declaredEnd, segments[segments.length - 1]!.endTime);
		// singer 0 is the main voice; the next one is "v2" (alt), the one after "v3" (main again)...
		const alt = (singer + 1) % 2 === 0;
		paragraphs.push({
			id: uuid(),
			lines: [createLyricLine(text, lineStart, end, { kind: "main", alt }, segments)],
		});
	}

	log(`[QRC] ${paragraphs.length} lyrics parsed successfully`);
	return paragraphs;
}

// ---------------------------------------------------------------------------
// Fetch layer (the Cider Lyrics Studio community lyrics, keyed on the song's catalogue id)
//
// Better Lyrics, Unison and LRCLIB are looked up by title/artist and live in their own modules next to this one.
// ---------------------------------------------------------------------------

export class NafynLyrics {
	/** Best available Cider community lyrics response for a song id. */
	async fetchCiderResponse(
		songId: string,
	): Promise<StudioLyricResponse | null> {
		try {
			const all = await fetchAllLyrics(songId);
			if (all.length === 0) return null;

			const sorted = [...all].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
			return sorted[0] ?? null;
		} catch (e) {
			logError(e);
			return null;
		}
	}

	/** Cider community lyrics, parsed into `LyricParagraphs`. */
	async fetchCiderParagraphs(songId: string): Promise<LyricParagraphs | null> {
		const cider = await this.fetchCiderResponse(songId);
		if (!cider) return null;

		const parsed = new TTMLParser(cider.ttml).parse();
		log(
			`[NafynLyrics] ${parsed && parsed.length > 0 ? `${parsed.length} lyrics parsed successfully` : "Failed to parse lyrics"}`,
		);
		return parsed;
	}
}
