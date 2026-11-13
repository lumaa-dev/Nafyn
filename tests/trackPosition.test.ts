import { describe, expect, test } from "bun:test";
import { findRecordingTrack, trackPosition } from "../server/utils/trackPosition";

describe("trackPosition", () => {
    test("uses MusicBrainz' integer position", () => {
        expect(trackPosition({ position: 4, number: "4" })).toBe(4);
    });

    test("never reads a vinyl side as a number", () => {
        expect(trackPosition({ position: 7, number: "B3" })).toBe(7);
        // no position at all: the printed "B3" is not a track number, the place in the medium is
        expect(trackPosition({ number: "B3" }, { tracks: [] }, 6)).toBe(7);
    });

    test("falls back to a plainly numeric printed number", () => {
        expect(trackPosition({ number: "12" })).toBe(12);
        expect(trackPosition({ position: "3" })).toBe(3);
    });

    test("uses track-offset in a recording lookup", () => {
        expect(trackPosition({ number: "A2" }, { "track-offset": 1, tracks: [{ number: "A2" }] }, 0)).toBe(2);
    });

    test("is null when nothing says where the track is", () => {
        expect(trackPosition({ number: "A1" })).toBeNull();
        expect(trackPosition({ position: 0 })).toBeNull();
    });
});

describe("findRecordingTrack", () => {
    test("matches the recording's track by id in a release browse", () => {
        const media = [
            { position: 1, tracks: [{ position: 1, recording: { id: "a" } }] },
            { position: 2, tracks: [{ position: 1, recording: { id: "b" } }, { position: 2, recording: { id: "c" } }] }
        ];
        const found = findRecordingTrack(media, "C");
        expect(found?.medium.position).toBe(2);
        expect(found?.index).toBe(1);
    });

    test("accepts a track without a recording (recording lookup shape)", () => {
        const media = [{ position: 2, "track-offset": 4, tracks: [{ number: "B1", position: 5, title: "x" }] }];
        const found = findRecordingTrack(media, "r");
        expect(found).not.toBeNull();
        expect(trackPosition(found!.track, found!.medium, found!.index)).toBe(5);
        expect(found!.medium.position).toBe(2);
    });

    test("prefers an id match over a recording-less track", () => {
        const media = [
            { position: 1, tracks: [{ position: 1 }] },
            { position: 2, tracks: [{ position: 3, recording: { id: "r" } }] }
        ];
        expect(findRecordingTrack(media, "r")?.medium.position).toBe(2);
    });
});
