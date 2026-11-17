import { beforeEach, describe, expect, test } from "bun:test";
import { cacheLyrics, clearLyricsCache, forgetCachedLyrics, getCachedLyrics, LYRICS_CACHE_TTL_MS, lyricsCacheKey, setCachedLyricsOffset, type LyricsAnswer } from "../../server/utils/lyrics/cache";
import { Provider } from "../../server/utils/lyrics/provider";

const synced: LyricsAnswer = { provider: Provider.Lrclib, syncType: "synced", lyrics: [{ startTimeMs: 1000, durationMs: 1000, words: "a" }], songwriters: [] };
const key = lyricsCacheKey({ mediaId: "m1", title: "T", artist: "A", isrcs: [] });

describe("lyrics cache and offset", () => {
	beforeEach(() => clearLyricsCache());

	test("the offset lives with the cached lyrics, clamped and rounded", () => {
		cacheLyrics(key, "m1", synced, 0);
		expect(getCachedLyrics(key, 1)).toEqual({ answer: synced, offsetMs: 0 });
		expect(setCachedLyricsOffset(key, 250.4, 1)).toBe(true);
		expect(getCachedLyrics(key, 2)!.offsetMs).toBe(250);
		setCachedLyricsOffset(key, -99_999, 3);
		expect(getCachedLyrics(key, 4)!.offsetMs).toBe(-30_000);
	});

	test("it expires with them, and new lyrics start from 0", () => {
		cacheLyrics(key, "m1", synced, 0);
		setCachedLyricsOffset(key, 500, 1);
		expect(getCachedLyrics(key, LYRICS_CACHE_TTL_MS + 1)).toBeUndefined();
		expect(setCachedLyricsOffset(key, 500, LYRICS_CACHE_TTL_MS + 1)).toBe(false);
		cacheLyrics(key, "m1", synced, LYRICS_CACHE_TTL_MS + 2);
		expect(getCachedLyrics(key, LYRICS_CACHE_TTL_MS + 3)!.offsetMs).toBe(0);
	});

	test("no lyrics, or unsynced ones, take no offset", () => {
		cacheLyrics(key, "m1", null, 0);
		expect(setCachedLyricsOffset(key, 500, 1)).toBe(false);
		cacheLyrics(key, "m1", { ...synced, syncType: "none" }, 0);
		expect(setCachedLyricsOffset(key, 500, 1)).toBe(false);
	});

	test("an edit of the user-written lyrics forgets every entry of the track", () => {
		const other = lyricsCacheKey({ mediaId: "m1", title: "T (renamed)", artist: "A", isrcs: [] });
		cacheLyrics(key, "m1", synced, 0);
		cacheLyrics(other, "m1", synced, 0);
		forgetCachedLyrics("m1");
		expect(getCachedLyrics(key, 1)).toBeUndefined();
		expect(getCachedLyrics(other, 1)).toBeUndefined();
	});
});
