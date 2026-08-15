// ---------------------------------------------------------------------------
// Types (ported from MusicLyricsResponse.swift)
// ---------------------------------------------------------------------------

/** Parameters for playing the lyrics. */
export interface PlayParams {
  /** The unique identifier for the play parameters. */
  id: string;
  /** The kind of play parameters. */
  kind: string;
  /** The catalog identifier associated with these play parameters. */
  catalogId: string;
  /** An integer representing the display type for the lyrics. */
  displayType: number;
}

/** Contains the lyrics content and play parameters. */
export interface LyricsAttributes {
  /** The lyrics content in TTML (Timed Text Markup Language) format. */
  ttml: string;
  /** Parameters related to playing the lyrics. */
  playParams: PlayParams;
}

/** The data for a single lyrics item. */
export interface LyricsData {
  /** The unique identifier for the lyrics item. */
  id: string;
  /** The type of the lyrics item. */
  type: string;
  /** The attributes containing the actual lyrics content and play parameters. */
  attributes: LyricsAttributes;
}

/** The response containing lyrics data. */
export interface MusicLyricsResponse {
  /** The fetched lyrics items. */
  data: LyricsData[];
}

// ---------------------------------------------------------------------------
// Apple Music API error shape
//
// Used internally by `response()` to detect an API-level error payload,
// the same way the Swift original decoded into `MusicErrorResponse` /
// `MusicError` for that check.
// ---------------------------------------------------------------------------

/** A single error from the Apple Music API. */
export interface MusicError {
  id: string;
  title: string;
  detail: string;
  status: string;
  code: string;
}

/** An error response from the Apple Music API. */
export interface MusicErrorResponse {
  errors: MusicError[];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// MusicLyricsRequest (constructor + response() only)
// ---------------------------------------------------------------------------

export class MusicLyricsRequest {
  /**
   * Sends the request and returns a response object containing the
   * fetched lyrics.
   *
   * @param countryCode - Apple Music storefront country code (e.g.
   *   `"us"`). Defaults to `"us"` — see the module header for why this
   *   isn't auto-resolved the way the Swift original did.
   * @throws {Error} mirroring the Swift `MusanovaKitError` cases:
   *   empty response, an Apple Music API error, a decode failure, or a
   *   network failure.
   */
  async response(songId: string | number, devToken: string, countryCode: string = "us"): Promise<MusicLyricsResponse> {
    const url = `https://amp-api.music.apple.com/v1/catalog/${encodeURIComponent(countryCode)}/songs/${encodeURIComponent(songId)}/syllable-lyrics`

    var bodyText: string;
    try {
      const httpResponse = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${devToken}`
        },
      });      
      
      bodyText = await httpResponse.text();
    } catch (e) {
      // Ports the outer `catch let error as URLError` / final `catch`
      // branches → `MusanovaKitError.networkError(_:)`.
      throw new Error(`MusicLyricsRequest: network error — ${errorMessage(e)}`);
    }

    if (bodyText.length === 0) {
      // Ports `MusanovaKitError.emptyResponse`.
      throw new Error("MusicLyricsRequest: empty response");
    }

    let apiError: Error | null = null;
    try {
      const maybeError = JSON.parse(bodyText) as Partial<MusicErrorResponse>;
      if (maybeError.errors && maybeError.errors.length > 0) {
        const first = maybeError.errors[0];
        // Ports `MusanovaKitError.apiError(message:code:status:)`.
        apiError = new Error(
          `MusicLyricsRequest: API error — ${first.detail} (code: ${first.code}, status: ${first.status})`
        );
      }
    } catch {
      // Not JSON, or JSON without an `errors` array — fall through.
    }
    if (apiError) throw apiError;

    // Swift's `guard String(data:encoding:.utf8) != nil` check has no
    // real TS equivalent: `Response.text()` always yields a valid JS
    // string, it can't fail to decode the way Swift's `String(data:)`
    // can. Kept here only as a note that `MusanovaKitError.invalidResponseFormat`
    // is structurally unreachable in this port.

    try {
      return JSON.parse(bodyText) as MusicLyricsResponse;
    } catch (e) {
      // Ports `MusanovaKitError.decodingError(_:)`.
      throw new Error(`MusicLyricsRequest: decoding error — ${errorMessage(e)}`);
    }
  }
}

export async function fetchAppleMusicTTML(
  songId: string,
  developerToken: string,
  countryCode: string | undefined = "us"
): Promise<string | null> {
  try {
    const response = await (new MusicLyricsRequest).response(songId, developerToken, countryCode);
    
    const ttml = response.data[0]?.attributes.ttml ?? null;
    console.log(`[MusicLyricsRequest+fetchTTML] ${ttml !== null ? "Fetched lyrics successfully" : "Failed to fetch lyrics"}`);
    return ttml;
  } catch (e) {
    console.error(e);
    
    return null;
  }
}