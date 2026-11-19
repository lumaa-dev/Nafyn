import { describe, expect, test } from "bun:test";
import { audioDbAlbumTags, audioDbTagsOf, mergeTags, moodFromTag, tagGenres, tagWords } from "../server/utils/audioDbTags";
import { moodOf } from "../server/utils/recommender/mixes/types";

const ALBUM = "b1392450-e666-3926-a536-22c65f834433";

describe("TheAudioDB tags", () => {
    test("normalized, placeholders dropped", () => {
        expect(audioDbTagsOf({ strGenre: "  Psychedelic   Rock ", strStyle: "...", strMood: "Unknown" }))
            .toEqual({ genre: "psychedelic rock", style: null, mood: null });
        expect(audioDbTagsOf(null)).toEqual({ genre: null, style: null, mood: null });
        expect(audioDbTagsOf({ strGenre: 42, strStyle: null })).toEqual({ genre: null, style: null, mood: null });
    });

    test("an album answer: the album with that release-group ID, null when unknown", () => {
        expect(audioDbAlbumTags({ album: [{ strMusicBrainzID: ALBUM.toUpperCase(), strGenre: "Rock", strStyle: "Prog", strMood: "Dreamy" }] }, ALBUM))
            .toEqual({ genre: "rock", style: "prog", mood: "dreamy" });
        expect(audioDbAlbumTags({ album: [{ strMusicBrainzID: "another", strGenre: "Rock" }] }, ALBUM)).toBeNull();
        expect(audioDbAlbumTags({ album: null }, ALBUM)).toBeNull();
        expect(audioDbAlbumTags(null, ALBUM)).toBeNull();
    });

    test("the album's own tags win, the artist fills the gaps", () => {
        expect(mergeTags({ genre: "rock", style: null, mood: null }, { genre: "pop", style: "synthpop", mood: "happy" }))
            .toEqual({ genre: "rock", style: "synthpop", mood: "happy" });
        expect(mergeTags(null, undefined)).toEqual({ genre: null, style: null, mood: null });
    });

    test("genres and words", () => {
        expect(tagGenres({ genre: "rock", style: "rock", mood: "sad" })).toEqual(["rock"]);
        expect(tagGenres({ genre: "rock", style: "prog", mood: null })).toEqual(["rock", "prog"]);
        expect(tagWords({ genre: "rock", style: null, mood: "sad" })).toEqual(["rock", "sad"]);
        expect(tagWords(null)).toEqual([]);
    });

    test("moods map onto the four quadrants, anything else onto none", () => {
        expect(moodFromTag("Happy")).toBe("upbeat");
        expect(moodFromTag("Aggressive")).toBe("intense");
        expect(moodFromTag(" relaxed ")).toBe("mellow");
        expect(moodFromTag("Reflective")).toBe("melancholic");
        expect(moodFromTag("Strange")).toBeNull();
        expect(moodFromTag(null)).toBeNull();
    });

    test("measured audio wins over the editor's mood", () => {
        expect(moodOf(null, "mellow")).toBe("mellow");
        expect(moodOf(null)).toBeNull();
        const loud = { energy: 0.9, valence: 0.9 } as Parameters<typeof moodOf>[0];
        expect(moodOf(loud, "melancholic")).toBe("upbeat");
    });
});
