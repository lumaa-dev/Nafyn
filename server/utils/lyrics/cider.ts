/** A single community-submitted lyric entry from Cider Lyrics Studio. */
export interface StudioLyricResponse {
	/** The raw TTML document for this submission. */
	ttml: string;
	/**
	 * Ranking/quality signal, if the API returns one (votes, rating,
	 * recency, etc). The original Swift `StudioLyricResponse` was
	 * `Comparable`, and callers sorted with `sorted(by: >)` to pick the
	 * "best" submission — rename/populate this to match whatever field
	 * the API actually returns for that purpose.
	 */
	score?: number;
	/** Anything else the API sends back that isn't modeled above. */
	[key: string]: unknown;
}

/** The `/lyrics/user/{id}/all` endpoint's response envelope. */
export interface StudioTrackAllResponse {
	lyrics: StudioLyricResponse[];
	[key: string]: unknown;
}

export type LyricsStudioErrorKind = "badURL" | "responseError";

/**
 * Port of `LyricsStudioError`:
 * - `kind: "badURL"`        ports `LyricsStudioError.badURL(_:)`
 * - `kind: "responseError"` ports `LyricsStudioError.responseError(_:)`
 */
export class LyricsStudioError extends Error {
	readonly kind: LyricsStudioErrorKind;
	/** The malformed id (for `badURL`) or response body text (for `responseError`), if available. */
	readonly detail: string | null;

	private constructor(kind: LyricsStudioErrorKind, detail: string | null) {
		super(
			kind === "badURL"
				? `LyricsStudio: malformed or incorrect URL${detail ? ` (id: ${detail})` : ""}`
				: `LyricsStudio: response error${detail ? ` — ${detail}` : ""}`,
		);
		this.name = "LyricsStudioError";
		this.kind = kind;
		this.detail = detail;
	}

	static badURL(detail: string | null = null): LyricsStudioError {
		return new LyricsStudioError("badURL", detail);
	}

	static responseError(detail: string | null = null): LyricsStudioError {
		return new LyricsStudioError("responseError", detail);
	}
}

const CIDER_LYRICS_BASE_URL = "https://exp-rise.cider.sh/api/v1/lyrics/user";

/**
 * Fetches all of Cider Lyrics Studio's community lyric submissions for a
 * song id.
 *
 * @param id - The song's Apple Music id (Swift's `MusicItemID.rawValue`).
 * @param options.signal - Optional external `AbortSignal` to cancel the
 *   request early; combined with the built-in 20s timeout, whichever
 *   fires first wins.
 * @returns The community-submitted `StudioLyricResponse[]`.
 * @throws {LyricsStudioError} `kind: "badURL"` if `id` produces a
 *   malformed request URL; `kind: "responseError"` if the HTTP response
 *   status wasn't in the 200–299 range.
 */
export async function fetchAllLyrics(
	id: string
): Promise<StudioLyricResponse[]> {
	let url: string;
	try {
		url = new URL(
			`${CIDER_LYRICS_BASE_URL}/${encodeURIComponent(id)}/all`,
		).toString();
	} catch {
		throw LyricsStudioError.badURL(id);
	}

	const response = await fetch(url, {
		method: "GET",
		cache: "no-store",
	});

	if (!response.ok) {
		const bodyText = await response.text().catch(() => null);
		throw LyricsStudioError.responseError(bodyText);
	}

	const json = (await response.json()) as StudioTrackAllResponse;
	return json.lyrics;
}
