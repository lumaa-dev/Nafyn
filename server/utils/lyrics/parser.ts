// ---------------------------------------------------------------------------
// Core data model
// ---------------------------------------------------------------------------

import { fetchAppleMusicTTML } from "./am";
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
	AppleMusic = "appleMusic",
	Cider = "cider",
	Lrclib = "lrclib",
	Cache = "cache",
}

export function providerLocalized(provider: Provider): string {
	switch (provider) {
		case Provider.AppleMusic:
			return "Apple Music";
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
 * matters for lines like "you're" or "animal" that Apple Music TTML
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
// TTML from Apple Music / Cider Lyrics Studio is well-formed, simple XML:
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
 * Parses TTML lyrics (Apple Music beat-by-beat, or legacy paragraph-based
 * / Cider Lyrics Studio) into `LyricParagraphs`.
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
			parseXML(this.ttml, {
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
// Fetch layer (ports the `AmberLyrics` static fetch functions)
//
// MusicKit / MusanovaKit / LyricsStudioKit have no JS/TS equivalent, so
// this is expressed against small injectable interfaces instead of a
// literal 1:1 port. Implement these against MusicKit JS, your backend,
// and/or the Cider Lyrics Studio API.
// ---------------------------------------------------------------------------

interface CiderTokenResponse {
	token: string;
	expires_at: string;
}

let cachedPrivilegedToken: string | null = null;

/** Ports Swift's fetchPrivilegedToken(): grab + cache Apple Music dev token from Cider's relay. */
async function fetchPrivilegedToken(): Promise<string> {
	if (cachedPrivilegedToken !== null) {
		return cachedPrivilegedToken;
	}

	const res = await fetch("https://rise.cider.sh/api/v1/token/current");
	if (!res.ok) {
		throw new Error(`Failed to fetch privileged token: HTTP ${res.status}`);
	}

	const token = (await res.json()) as CiderTokenResponse;
	
	if (new Date(token.expires_at) > new Date()) {
		cachedPrivilegedToken = token.token;
		return token.token;
	} else {
		throw new Error("Privileged token fetched expired");
	}
}

export class NafynLyrics {
	async fetchAppleMusicTTML(songId: string): Promise<string | null> {
		try {
			const ttml = await fetchAppleMusicTTML(
				songId,
				await fetchPrivilegedToken(),
			);
			
			log(
				`[NafynLyrics] ${ttml != null ? "Fetched lyrics successfully" : "Failed to fetch lyrics"}`,
			);
			return ttml;
		} catch (e) {
			logError(e);
			return null;
		}
	}

	/** Apple Music TTML, parsed into `LyricParagraphs`. */
	async fetchAppleMusicParagraphs(
		songId: string,
	): Promise<LyricParagraphs | null> {
		const ttml = await this.fetchAppleMusicTTML(songId);
		if (ttml == null) return null;

		const parsed = new TTMLParser(ttml).parse();
		log(
			`[NafynLyrics] ${parsed && parsed.length > 0 ? `${parsed.length} lyrics parsed successfully` : "Failed to parse lyrics"}`,
		);
		return parsed;
	}

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

	/**
	 * Fetches Apple Music's lyrics, but prefers Cider's community lyrics
	 * when they're a better fit (e.g. Apple Music's are static/unsynced
	 * but Cider's are time-synced).
	 */
	async fetchWithCider(
		songId: string,
	): Promise<{ paragraphs: LyricParagraphs; provider: Provider } | null> {
		const amParagraphs = await this.fetchAppleMusicParagraphs(songId);

		if (amParagraphs && isBeatByBeat(amParagraphs)) {
			log("[NafynLyrics] B-by-B AM paragraphs");
			return { paragraphs: amParagraphs, provider: Provider.AppleMusic };
		}

		const ciderParagraphs = await this.fetchCiderParagraphs(songId);
		if (ciderParagraphs) {
			const amIsStatic = amParagraphs ? isStatic(amParagraphs) : true;
			if (!isStatic(ciderParagraphs) || amIsStatic) {
				log("[NafynLyrics] Active Cider paragraphs");
				return { paragraphs: ciderParagraphs, provider: Provider.Cider };
			} else {
				log("[NafynLyrics] AM paragraphs");
				return {
					paragraphs: amParagraphs as LyricParagraphs,
					provider: Provider.AppleMusic,
				};
			}
		}

		if (!amParagraphs) return null;
		return { paragraphs: amParagraphs, provider: Provider.AppleMusic };
	}
}
