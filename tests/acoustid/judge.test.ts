import { describe, expect, test } from "bun:test";
import { DEFAULT_MATCH_CONFIG, aliasLookupCandidates, judge, rankCandidates, type AcoustIdResult, type ExpectedRecording } from "../../server/utils/acoustidMatch";

const config = DEFAULT_MATCH_CONFIG;

const expected: ExpectedRecording = {
    recordingId: "11111111-1111-1111-1111-111111111111",
    aliases: ["22222222-2222-2222-2222-222222222222"],
    title: "Blinding Lights",
    artistName: "The Weeknd",
    duration: 200
};

function answer(score: number, id: string, title: string, artist: string, duration = 200): AcoustIdResult[] {
    return [{ id: "x", score, recordings: [{ id, title, duration, artists: [{ name: artist }] }] }];
}

function judged(results: AcoustIdResult[], canonical?: Map<string, string>, measured = 200) {
    return judge(rankCandidates(results, measured, config), expected, config, canonical);
}

describe("judge", () => {
    test("matches the requested recording id", () => {
        const verdict = judged(answer(0.95, expected.recordingId, "Blinding Lights", "The Weeknd"));
        expect(verdict.matched).toBe(true);
        expect(verdict.via).toBe("mbid");
    });

    test("matches a merged-away id the request carried as an alias", () => {
        const verdict = judged(answer(0.9, expected.aliases[0]!, "Blinding Lights", "The Weeknd"));
        expect(verdict.matched).toBe(true);
        expect(verdict.via).toBe("alias");
    });

    test("matches a candidate MusicBrainz resolves to the requested recording", () => {
        const stale = "33333333-3333-3333-3333-333333333333";
        const verdict = judged(answer(0.9, stale, "Blinding Lights", "The Weeknd"), new Map([[stale, expected.recordingId]]));
        expect(verdict.matched).toBe(true);
        expect(verdict.via).toBe("mbid");
    });

    test("matches the same song entered under another recording id", () => {
        const verdict = judged(answer(0.93, "44444444-4444-4444-4444-444444444444", "Blinding Lights", "The Weeknd"));
        expect(verdict.matched).toBe(true);
        expect(verdict.via).toBe("identity");
    });

    test("tolerates a bracketed edition suffix when comparing titles", () => {
        const verdict = judged(answer(0.93, "44444444-4444-4444-4444-444444444444", "Blinding Lights (Remastered 2020)", "The Weeknd"));
        expect(verdict.matched).toBe(true);
    });

    test("does not take title + artist agreement at a mediocre score", () => {
        const verdict = judged(answer(0.75, "44444444-4444-4444-4444-444444444444", "Blinding Lights", "The Weeknd"));
        expect(verdict.matched).toBe(false);
    });

    test("flags a confident candidate that is a different song", () => {
        const verdict = judged(answer(0.97, "55555555-5555-5555-5555-555555555555", "Starboy", "The Weeknd"));
        expect(verdict.matched).toBe(false);
        expect(verdict.confidentOther?.title).toBe("Starboy");
    });

    test("does not flag a weak candidate that is a different song", () => {
        const verdict = judged(answer(0.75, "55555555-5555-5555-5555-555555555555", "Starboy", "The Weeknd"));
        expect(verdict.matched).toBe(false);
        expect(verdict.confidentOther).toBeNull();
    });

    test("a wrong-length recording under the right id is not a match", () => {
        const verdict = judged(answer(0.95, expected.recordingId, "Blinding Lights", "The Weeknd", 320));
        expect(verdict.matched).toBe(false);
    });

    test("an empty answer is neither a match nor a contradiction", () => {
        const verdict = judged([]);
        expect(verdict.matched).toBe(false);
        expect(verdict.confidentOther).toBeNull();
        expect(verdict.best).toBeNull();
    });

    test("prefers the requested id over a higher-scoring identity match", () => {
        const verdict = judged([
            ...answer(0.99, "44444444-4444-4444-4444-444444444444", "Blinding Lights", "The Weeknd"),
            ...answer(0.88, expected.recordingId, "Blinding Lights", "The Weeknd")
        ]);
        expect(verdict.via).toBe("mbid");
    });
});

describe("aliasLookupCandidates", () => {
    test("offers only strong candidates that are not already the requested id, capped", () => {
        const results: AcoustIdResult[] = [{
            id: "x", score: 0.95, recordings: [
                { id: expected.recordingId, title: "t", duration: 200 },
                { id: "aa", title: "t", duration: 200 },
                { id: "bb", title: "t", duration: 200 },
                { id: "cc", title: "t", duration: 200 },
                { id: "dd", title: "t", duration: 200 }
            ]
        }, { id: "y", score: 0.72, recordings: [{ id: "weak", title: "t", duration: 200 }] }];
        const ids = aliasLookupCandidates(rankCandidates(results, 200, config), expected, config);
        expect(ids).toEqual(["aa", "bb", "cc"]);
    });
});
