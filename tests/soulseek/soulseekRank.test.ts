import { describe, expect, test } from "bun:test";
import { rankByDuration } from "../../server/utils/soulseekRank";

const lengths = (results: Array<{ length?: number }>) => results.map((result) => result.length);

describe("rankByDuration", () => {
    test("nearest to furthest from the MusicBrainz length", () => {
        const ranked = rankByDuration([{ length: 250 }, { length: 181 }, { length: 100 }, { length: 179 }, { length: 180 }], 180);
        expect(lengths(ranked)).toEqual([180, 181, 179, 250, 100]);
    });

    test("a file of unknown length comes after the ones within tolerance and before the ones far off", () => {
        const ranked = rankByDuration([{ length: 300 }, {}, { length: 183 }, { length: 0 }, { length: 178 }], 180);
        expect(lengths(ranked)).toEqual([178, 183, undefined, 0, 300]);
    });

    test("same distance: higher bitrate, then faster peer, then the order they arrived in", () => {
        const ranked = rankByDuration([
            { length: 179, bitrate: 128, speed: 9 },
            { length: 181, bitrate: 320, speed: 1 },
            { length: 181, bitrate: 320, speed: 5 },
            { length: 181, bitrate: 320, speed: 5, id: "later" }
        ] as Array<{ length: number, bitrate: number, speed: number, id?: string }>, 180);
        expect(ranked.map((result) => result.bitrate)).toEqual([320, 320, 320, 128]);
        expect(ranked.map((result) => result.speed)).toEqual([5, 5, 1, 9]);
        expect(ranked[1]!.id).toBe("later");
    });

    test("no MusicBrainz length: quality order, nothing dropped", () => {
        const ranked = rankByDuration([{ length: 10, bitrate: 128 }, { length: 999, bitrate: 320 }], 0);
        expect(lengths(ranked)).toEqual([999, 10]);
    });

    test("does not mutate its input", () => {
        const input = [{ length: 300 }, { length: 180 }];
        rankByDuration(input, 180);
        expect(lengths(input)).toEqual([300, 180]);
    });
});
