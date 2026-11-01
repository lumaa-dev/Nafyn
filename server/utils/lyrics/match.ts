// ---------------------------------------------------------------------------
// "Is this lyric file really for this song?" - pure, shared by the providers that look a track up by
// title/artist (Better Lyrics, Unison). A same-titled cover, a live take or somebody else's song of the same
// name must never get lyrics that belong to another recording, so every check here errs on refusing.
// ---------------------------------------------------------------------------

import type { LyricParagraphs } from "./parser";

export interface TrackLookup {
	trackName: string;
	artistName: string;
	albumName?: string;
	/** Seconds. */
	duration?: number;
}

/** Lowercase, accents and punctuation gone, one space between words. */
export function foldLyricsText(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

// "(feat. X)", "[ft. X]", "(with X)" and a trailing "feat. X" name a guest, not another version of the song
const GUEST_RE = /[([]\s*(?:feat\.?|featuring|ft\.?|with)\s[^)\]]*[)\]]|\s(?:feat\.?|featuring|ft\.?)\s.*$/giu;

/**
 * The title as compared: a featured guest is ignored, anything else in the title (live, remix, acoustic,
 * remastered, "pt. 2", ...) is part of it - "Song (Live)" is not "Song".
 */
export function titleKey(title: string): string {
	return foldLyricsText(title.replace(GUEST_RE, " "));
}

/** Every credited name in an artist string ("A, B & C feat. D"), folded. */
export function creditedNames(artist: string): string[] {
	const names = artist
		.split(/\s*(?:,|&|;|\/|\+|\band\b|\bx\b|\bfeat\.?|\bfeaturing\b|\bft\.?|\bwith\b|\bvs\.?)\s*/iu)
		.map(foldLyricsText)
		.filter((name) => name.length > 0);
	const whole = foldLyricsText(artist);
	return whole && !names.includes(whole) ? [whole, ...names] : names;
}

/** The two credits share at least one whole credited name ("Madlib & Madvillain" ~ "Madvillain"). */
export function artistsShare(a: string, b: string): boolean {
	const right = new Set(creditedNames(b));
	return creditedNames(a).some((name) => right.has(name));
}

/** How far a lyric's own length may differ from the track's, in seconds. */
export const LYRICS_DURATION_TOLERANCE_SECONDS = 3;

export function sameTrackByName(
	lookup: Pick<TrackLookup, "trackName" | "artistName">,
	found: { song?: string | null; artist?: string | null },
): boolean {
	if (!found.song || !found.artist) return false;
	const wanted = titleKey(lookup.trackName);
	return wanted !== "" && wanted === titleKey(found.song) && artistsShare(lookup.artistName, found.artist);
}

/**
 * Timed lyrics cannot run past the end of the song they belong to: a final line that ends well after the track
 * does is another (longer) recording's. Static lyrics carry no timing and prove nothing, so they pass.
 */
export function lyricsFitDuration(paragraphs: LyricParagraphs, durationSeconds: number | undefined): boolean {
	if (!durationSeconds || durationSeconds <= 0) return true;

	let lastEnd = 0;
	for (const paragraph of paragraphs) {
		for (const line of paragraph.lines) {
			lastEnd = Math.max(lastEnd, line.endTime, line.segments[line.segments.length - 1]?.endTime ?? 0);
		}
	}
	return lastEnd <= durationSeconds + 5;
}
