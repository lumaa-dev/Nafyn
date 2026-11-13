import { describe, expect, test } from "bun:test";
import { apiSignature, isScrobbleWorthy, scrobbleParams, signedCall, LastfmApiError } from "../server/utils/lastfmApi";
import { createHash } from "node:crypto";

describe("Last.fm", () => {
    test("api_sig sorts parameters and skips format/callback", () => {
        const sig = apiSignature({ token: "T", method: "auth.getSession", api_key: "K", format: "json" }, "S");
        expect(sig).toBe(createHash("md5").update("api_keyKmethodauth.getSessiontokenTS").digest("hex"));
    });

    test("api_sig hashes UTF-8", () => {
        const sig = apiSignature({ track: "二十歳の恋" }, "S");
        expect(sig).toBe(createHash("md5").update(Buffer.from("track二十歳の恋S", "utf8")).digest("hex"));
    });

    test("scrobble rule: > 30 s track, half of it or 4 minutes", () => {
        expect(isScrobbleWorthy(20_000, 25)).toBe(false);
        expect(isScrobbleWorthy(100_000, 200)).toBe(true);
        expect(isScrobbleWorthy(99_000, 200)).toBe(false);
        expect(isScrobbleWorthy(240_000, 1200)).toBe(true);
        expect(isScrobbleWorthy(31_000, 0)).toBe(true);
    });

    test("scrobble params are indexed and optional ones skipped", () => {
        const params = scrobbleParams([{ artist: "A", track: "T", album: null, timestamp: 1700000000.6, duration: 200, trackNumber: null, mbid: "m" }]);
        expect(params).toEqual({ "artist[0]": "A", "track[0]": "T", "timestamp[0]": "1700000000", "duration[0]": "200", "mbid[0]": "m" });
    });

    test("an error body becomes a LastfmApiError, invalid session flagged", async () => {
        const fetchImpl = (async () => new Response(JSON.stringify({ error: 9, message: "Invalid session key" }), { status: 403 })) as unknown as typeof fetch;
        const call = signedCall("track.scrobble", {}, { apiKey: "K", secret: "S" }, { post: true, fetchImpl });
        await expect(call).rejects.toBeInstanceOf(LastfmApiError);
        await call.catch((e: LastfmApiError) => expect(e.invalidSession).toBe(true));
    });
});
