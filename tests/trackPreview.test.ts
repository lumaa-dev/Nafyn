import { describe, expect, test } from "bun:test";
import { isAllowedPreviewHost, pickPreview, previewScore, type ITunesSong } from "../server/utils/trackPreviewPick";

const song = (fields: Partial<ITunesSong>): ITunesSong => ({ kind: "song", previewUrl: "https://audio-ssl.itunes.apple.com/a.m4a", ...fields });

describe("track previews", () => {
    const target = { title: "One Trick", artist: "Lovejoy", duration: 200 };

    test("same title, artist and length is a preview", () => {
        expect(previewScore(song({ trackName: "One Trick", artistName: "Lovejoy", trackTimeMillis: 201_000 }), target)).toBeGreaterThan(0.9);
    });

    test("a featuring in the iTunes title is ignored", () => {
        expect(previewScore(song({ trackName: "One Trick (feat. Someone)", artistName: "Lovejoy", trackTimeMillis: 200_000 }), target)).not.toBeNull();
    });

    test("another version, artist or length is not", () => {
        expect(previewScore(song({ trackName: "One Trick (Live)", artistName: "Lovejoy", trackTimeMillis: 200_000 }), target)).toBeNull();
        expect(previewScore(song({ trackName: "One Trick", artistName: "Someone Else", trackTimeMillis: 200_000 }), target)).toBeNull();
        expect(previewScore(song({ trackName: "One Trick", artistName: "Lovejoy", trackTimeMillis: 260_000 }), target)).toBeNull();
        expect(previewScore(song({ trackName: "One Trick", artistName: "Lovejoy", previewUrl: undefined }), target)).toBeNull();
    });

    test("a joint credit matches one of its artists", () => {
        expect(previewScore(song({ trackName: "One Trick", artistName: "Lovejoy & Friend", trackTimeMillis: 200_000 }), target)).not.toBeNull();
    });

    test("the closest length wins", () => {
        const picked = pickPreview([
            song({ trackId: 1, trackName: "One Trick", artistName: "Lovejoy", trackTimeMillis: 204_000 }),
            song({ trackId: 2, trackName: "One Trick", artistName: "Lovejoy", trackTimeMillis: 200_000 })
        ], target);
        expect(picked?.trackId).toBe(2);
    });

    test("only Apple's hosts over https", () => {
        expect(isAllowedPreviewHost("https://audio-ssl.itunes.apple.com/itunes-assets/x.m4a")).toBe(true);
        expect(isAllowedPreviewHost("http://audio-ssl.itunes.apple.com/x.m4a")).toBe(false);
        expect(isAllowedPreviewHost("https://evil.example/x.m4a")).toBe(false);
        expect(isAllowedPreviewHost("https://apple.com.evil.example/x.m4a")).toBe(false);
    });
});
