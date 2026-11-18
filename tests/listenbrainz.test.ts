import { describe, expect, test } from "bun:test";
import { isListenWorthy, ListenBrainzApiError, listensPayload, submitListens, validateToken, type ListenTrack } from "../server/utils/listenbrainzApi";

const CLIENT = { name: "Nafyn", version: "1.0.0" };
const TRACK: ListenTrack = {
    artist: "A", track: "T", album: null, listenedAt: 1700000000.6, duration: 200, trackNumber: null,
    recordingMbid: "ABCDEF01-0000-4000-8000-000000000000", artistMbid: "not an mbid"
};

describe("ListenBrainz", () => {
    test("listen rule: > 30 s track, half of it or 4 minutes", () => {
        expect(isListenWorthy(20_000, 25)).toBe(false);
        expect(isListenWorthy(100_000, 200)).toBe(true);
        expect(isListenWorthy(99_000, 200)).toBe(false);
        expect(isListenWorthy(240_000, 1200)).toBe(true);
        expect(isListenWorthy(31_000, 0)).toBe(true);
    });

    test("one listen is `single`, its optional fields skipped and MBIDs checked", () => {
        expect(listensPayload([TRACK], CLIENT)).toEqual({
            listen_type: "single",
            payload: [{
                listened_at: 1700000000,
                track_metadata: {
                    artist_name: "A",
                    track_name: "T",
                    additional_info: {
                        submission_client: "Nafyn",
                        submission_client_version: "1.0.0",
                        duration_ms: 200_000,
                        recording_mbid: "abcdef01-0000-4000-8000-000000000000"
                    }
                }
            }]
        });
    });

    test("several listens are an `import`; playing now has no timestamp", () => {
        expect(listensPayload([TRACK, { ...TRACK, album: "Al", trackNumber: 3 }], CLIENT).listen_type).toBe("import");
        const now = listensPayload([TRACK], CLIENT, true);
        expect(now.listen_type).toBe("playing_now");
        expect(now.payload[0]).not.toHaveProperty("listened_at");
    });

    test("validate-token: the username of a valid token, null otherwise", async () => {
        const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
        expect(await validateToken("t", { fetchImpl: answer({ code: 200, valid: true, user_name: "rj" }) })).toBe("rj");
        expect(await validateToken("t", { fetchImpl: answer({ code: 200, valid: false }) })).toBeNull();
    });

    test("a refused token is a ListenBrainzApiError flagged invalidToken", async () => {
        const fetchImpl = (async () => new Response(JSON.stringify({ code: 401, error: "Invalid authorization token." }), { status: 401 })) as unknown as typeof fetch;
        const call = submitListens("t", listensPayload([TRACK], CLIENT), { fetchImpl });
        await expect(call).rejects.toBeInstanceOf(ListenBrainzApiError);
        await call.catch((e: ListenBrainzApiError) => expect(e.invalidToken).toBe(true));
    });
});
