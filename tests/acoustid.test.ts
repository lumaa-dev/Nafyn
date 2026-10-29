import { describe, expect, test } from "bun:test";
import { DEFAULT_MATCH_CONFIG, aliasLookupCandidates, judge, rankCandidates, readMatchConfig, type AcoustIdResult, type ExpectedRecording } from "../server/utils/acoustidMatch";

const config = DEFAULT_MATCH_CONFIG;

function result(score: number, ...recordings: { id: string, duration?: number, title?: string, artist?: string }[]): AcoustIdResult {
    return {
        id: `acoustid-${score}`,
        score,
        recordings: recordings.map((r) => ({ id: r.id, duration: r.duration, title: r.title, artists: r.artist ? [{ name: r.artist }] : undefined }))
    };
}

describe("rankCandidates", () => {
    test("drops results below the score threshold", () => {
        const ranked = rankCandidates([result(0.4, { id: "a" }), result(0.8, { id: "b" })], 200, config);
        expect(ranked.map((c) => c.id)).toEqual(["b"]);
    });

    test("drops recordings whose known duration is far from the measured one", () => {
        const ranked = rankCandidates([result(0.95, { id: "live", duration: 320 }, { id: "studio", duration: 201 })], 200, config);
        expect(ranked.map((c) => c.id)).toEqual(["studio"]);
    });

    test("keeps a recording AcoustID has no duration for", () => {
        const ranked = rankCandidates([result(0.9, { id: "no-length" })], 200, config);
        expect(ranked).toHaveLength(1);
        expect(ranked[0]!.durationDelta).toBeNull();
    });

    test("keeps the best score when several results list the same recording", () => {
        const ranked = rankCandidates([result(0.75, { id: "same" }), result(0.92, { id: "same" })], 200, config);
        expect(ranked).toHaveLength(1);
        expect(ranked[0]!.score).toBe(0.92);
    });

    test("ranks by score, then by closer duration, then by id", () => {
        const ranked = rankCandidates([
            result(0.9, { id: "z", duration: 203 }, { id: "a", duration: 203 }, { id: "m", duration: 200 }),
            result(0.99, { id: "top", duration: 204 })
        ], 200, config);
        expect(ranked.map((c) => c.id)).toEqual(["top", "m", "a", "z"]);
    });

    test("lower-cases ids so a casing difference never hides a match", () => {
        const ranked = rankCandidates([result(0.9, { id: "ABC-DEF" })], 200, config);
        expect(ranked[0]!.id).toBe("abc-def");
    });

    test("returns nothing for an empty answer", () => {
        expect(rankCandidates([], 200, config)).toEqual([]);
    });

    test("ignores the measured duration filter when the measurement is unknown", () => {
        const ranked = rankCandidates([result(0.9, { id: "a", duration: 500 })], 0, config);
        expect(ranked).toHaveLength(1);
    });
});

describe("readMatchConfig", () => {
    test("falls back to defaults for missing or invalid values", () => {
        expect(readMatchConfig({})).toEqual(DEFAULT_MATCH_CONFIG);
        expect(readMatchConfig({ NAFYN_ACOUSTID_MIN_SCORE: "banana", NAFYN_ACOUSTID_DURATION_TOLERANCE: "-3" })).toEqual(DEFAULT_MATCH_CONFIG);
    });

    test("reads overrides within range", () => {
        const custom = readMatchConfig({ NAFYN_ACOUSTID_MIN_SCORE: "0.8", NAFYN_ACOUSTID_DURATION_TOLERANCE: "2", NAFYN_ACOUSTID_MAX_ALIAS_LOOKUPS: "1" });
        expect(custom.minScore).toBe(0.8);
        expect(custom.durationTolerance).toBe(2);
        expect(custom.maxAliasLookups).toBe(1);
    });
});


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

describe("judge: other names of the same song", () => {
    const japanese: ExpectedRecording = {
        recordingId: "44444444-4444-4444-4444-444444444444",
        aliases: [],
        title: "二十歳の恋",
        artistName: "Lamp",
        altTitles: ["Hatachi No Koi"],
        duration: 200
    };
    const other = "55555555-5555-5555-5555-555555555555";

    test("a confident candidate under the Latin release's title is the same song, not a contradiction", () => {
        const verdict = judge(rankCandidates(answer(0.95, other, "Hatachi no Koi", "Lamp"), 200, config), japanese, config);
        expect(verdict.matched).toBe(true);
        expect(verdict.via).toBe("identity");
        expect(verdict.confidentOther).toBeNull();
    });

    test("kana and its romanization are compared phonetically", () => {
        const kana: ExpectedRecording = { ...japanese, title: "ありがとう", altTitles: [], artistName: "いきものがかり", artistAliases: ["Ikimono-gakari"] };
        const verdict = judge(rankCandidates(answer(0.95, other, "Arigatou", "Ikimono-gakari"), 200, config), kana, config);
        expect(verdict.matched).toBe(true);
    });

    test("an artist alias counts as the artist", () => {
        const aliased: ExpectedRecording = { ...expected, artistName: "宇多田ヒカル", artistAliases: ["Hikaru Utada"] };
        const verdict = judge(rankCandidates(answer(0.95, other, "Blinding Lights", "Hikaru Utada"), 200, config), aliased, config);
        expect(verdict.matched).toBe(true);
    });

    test("a really different song is still a contradiction", () => {
        const verdict = judge(rankCandidates(answer(0.95, other, "Save Your Tears", "The Weeknd"), 200, config), { ...expected, altTitles: ["Blinding Lights (Remix)"] }, config);
        expect(verdict.confidentOther?.title).toBe("Save Your Tears");
    });

    test("alias lookups that could not run leave no contradiction behind", () => {
        const verdict = judge(rankCandidates(answer(0.95, other, "Save Your Tears", "The Weeknd"), 200, config), expected, config, new Map(), false);
        expect(verdict.matched).toBe(false);
        expect(verdict.confidentOther).toBeNull();
    });
});
