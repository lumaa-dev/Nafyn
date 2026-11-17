// ---------------------------------------------------------------------------
// Lyrics parsing - Braccato's (`@braccato/parsers`, https://github.com/better-lyrics/braccato), never our own.
//
// Every provider and the user-written lyrics go through here, so the whole server speaks one shape: Braccato's
// `Lyric[]` (`@braccato/types`), which is also what the web renderer (`@braccato/core`) takes and what the API
// returns. This file only adapts the parsers to Nafyn's needs (the track's length, the songwriters, a parser that
// throws or returns nothing) - it does not parse anything itself. Pure: no Nitro auto-imports, runs under bun test.
// ---------------------------------------------------------------------------

import { LRCParser, parseQRC, parseTTMLContent, PlainParser, QRCParser, TTMLParser } from "@braccato/parsers";
import type { Lyric, LyricSyncType } from "@braccato/types";

export type { Lyric, LyricPart, LyricSyncType } from "@braccato/types";

export interface ParsedLyrics {
	lyrics: Lyric[];
	/** Who wrote the song, as the file credits them (empty when it says nothing). */
	songwriters: string[];
	/** BCP 47 language the file declares (TTML only). */
	language?: string;
}

/** Whether the parsed lines hold any sung text at all (an instrumental line or a blank one is not a lyric). */
export function hasLyrics(lyrics: readonly Lyric[]): boolean {
	return lyrics.some((line) => !line.isInstrumental && line.words.trim().length > 0);
}

/** `null` for an empty / unparseable body, so every caller can treat "nothing usable" the same way. */
function finish(lyrics: Lyric[], songwriters: string[], language?: string): ParsedLyrics | null {
	if (!hasLyrics(lyrics)) return null;
	return language ? { lyrics, songwriters, language } : { lyrics, songwriters };
}

function guarded(name: string, run: () => ParsedLyrics | null): ParsedLyrics | null {
	try {
		return run();
	} catch (e) {
		console.error(`[lyrics] ${name} could not be parsed:`, e);
		return null;
	}
}

/** TTML (syllable/word/line-timed). `durationMs` is the track's length, used when `<body>` states none. */
export function parseTtml(ttml: string, durationMs?: number): ParsedLyrics | null {
	return guarded("TTML", () => {
		const { lyrics, language } = parseTTMLContent(ttml, durationMs ? { songDurationMs: durationMs } : {});
		return finish(lyrics, TTMLParser.metadata(ttml).songwriters, language);
	});
}

/** QRC, bare or in QQ Music's `<QrcInfos>` envelope. Lines that only restate the title/artist are dropped. */
export function parseQrc(qrc: string, durationMs: number | undefined, song: { title?: string; artist?: string } = {}): ParsedLyrics | null {
	return guarded("QRC", () => finish(parseQRC(qrc, durationMs ?? 0, song), QRCParser.metadata(qrc).songwriters));
}

/** LRC, plain or enhanced (word-timed). */
export function parseLrc(lrc: string, durationMs?: number): ParsedLyrics | null {
	return guarded("LRC", () => finish(LRCParser.parse(lrc, durationMs), LRCParser.metadata(lrc).songwriters));
}

/** Unsynced text: one line per line, blank lines kept as breaks between verses. */
export function parsePlain(text: string): ParsedLyrics | null {
	return guarded("plain text", () => finish(PlainParser.parse(text), []));
}

/**
 * How the lines are timed, by the same rule `@braccato/core` applies when it builds them: timed parts make
 * "richsync" (syllable/word), timed lines "synced", no time at all "none".
 */
export function lyricsSyncType(lyrics: readonly Lyric[]): LyricSyncType {
	if (lyrics.some((line) => !line.isInstrumental && line.parts?.some((part) => part.durationMs !== 0) === true)) return "richsync";
	return lyrics.every((line) => line.startTimeMs === 0) ? "none" : "synced";
}

/** Where the last sung line (or word) ends, in milliseconds; 0 for unsynced lyrics. */
export function lyricsEndMs(lyrics: readonly Lyric[]): number {
	let end = 0;
	for (const line of lyrics) {
		// the parsers pad the gaps with instrumental lines, the outro one up to the track's end: not lyrics
		if (line.isInstrumental) continue;
		end = Math.max(end, line.startTimeMs + line.durationMs);
		for (const part of line.parts ?? []) end = Math.max(end, part.startTimeMs + part.durationMs);
	}
	return end;
}
