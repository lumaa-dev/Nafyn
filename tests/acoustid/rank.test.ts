import { describe, expect, test } from "bun:test";
import { DEFAULT_MATCH_CONFIG, rankCandidates, readMatchConfig, type AcoustIdResult } from "../../server/utils/acoustidMatch";

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
