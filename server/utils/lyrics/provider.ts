/** Who answered a lyrics request (`provider` in `GET /api/v1/library/{id}/lyrics`). Shared with the web app. */
export enum Provider {
	/** Lyrics a Nafyn user wrote or pasted in themselves; they override every fetched provider. */
	Manual = "manual",
	BetterLyrics = "betterLyrics",
	/** Better Lyrics' QQ provider (`/qq/getLyrics`, word-timed QRC). */
	BetterLyricsPortato = "betterLyricsPortato",
	Unison = "unison",
	Cider = "cider",
	Lrclib = "lrclib",
	Cache = "cache",
}
