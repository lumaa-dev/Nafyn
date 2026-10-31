import { describe, expect, test } from "bun:test";
import { audioDbThumb, lastfmProfileFromRelations, lastfmProfileUrl, ogImage, usableImageUrl } from "../server/utils/artistImageParse";
import { coverOriginalUrl } from "../server/utils/coverUrl";

describe("lastfmProfileUrl", () => {
    test("canonical profile URLs, whatever the spelling", () => {
        expect(lastfmProfileUrl("https://www.last.fm/music/Radiohead")).toBe("https://www.last.fm/music/Radiohead");
        expect(lastfmProfileUrl("http://last.fm/music/Radiohead/")).toBe("https://www.last.fm/music/Radiohead");
        expect(lastfmProfileUrl("https://www.last.fm/fr/music/Daft+Punk/+images")).toBe("https://www.last.fm/music/Daft+Punk");
    });

    test("anything that is not a Last.fm artist profile is refused", () => {
        expect(lastfmProfileUrl("https://evil.example/music/Radiohead")).toBeNull();
        expect(lastfmProfileUrl("https://www.last.fm.evil.example/music/Radiohead")).toBeNull();
        expect(lastfmProfileUrl("https://www.last.fm/user/someone")).toBeNull();
        expect(lastfmProfileUrl("https://www.last.fm/music/+tag")).toBeNull();
        expect(lastfmProfileUrl("file:///etc/passwd")).toBeNull();
        expect(lastfmProfileUrl("not a url")).toBeNull();
        expect(lastfmProfileUrl(null)).toBeNull();
    });
});

describe("lastfmProfileFromRelations", () => {
    test("takes the last.fm relation among the artist's links", () => {
        expect(lastfmProfileFromRelations([
            { type: "official homepage", url: { resource: "https://example.org" } },
            { type: "last.fm", url: { resource: "https://www.last.fm/music/Radiohead" } }
        ])).toBe("https://www.last.fm/music/Radiohead");
    });

    test("none, or one that is not a profile: null", () => {
        expect(lastfmProfileFromRelations([])).toBeNull();
        expect(lastfmProfileFromRelations(undefined)).toBeNull();
        expect(lastfmProfileFromRelations([{ type: "last.fm", url: { resource: "https://example.org/music/x" } }])).toBeNull();
    });
});

describe("images", () => {
    test("the Last.fm placeholder and non-https URLs are not pictures", () => {
        expect(usableImageUrl("https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png")).toBeNull();
        expect(usableImageUrl("http://example.org/a.jpg")).toBeNull();
        expect(usableImageUrl("https://lastfm.freetls.fastly.net/i/u/ar0/abc.jpg")).toBe("https://lastfm.freetls.fastly.net/i/u/ar0/abc.jpg");
    });

    test("og:image in either attribute order, entities decoded", () => {
        expect(ogImage('<head><meta property="og:image" content="https://x.example/a.jpg?a=1&amp;b=2"></head>')).toBe("https://x.example/a.jpg?a=1&b=2");
        expect(ogImage("<meta content='https://x.example/b.jpg' property='og:image' />")).toBe("https://x.example/b.jpg");
        expect(ogImage('<meta property="og:title" content="x">')).toBeNull();
        expect(ogImage('<meta property="og:image" content="https://lastfm.freetls.fastly.net/i/u/ar0/2a96cbd8b46e442fc41c2b86b821562f.png">')).toBeNull();
    });

    test("TheAudioDB: the thumb of the artist with that MusicBrainz ID", () => {
        const mbid = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
        expect(audioDbThumb({ artists: [{ strMusicBrainzID: mbid.toUpperCase(), strArtistThumb: "https://r2.theaudiodb.com/t.jpg" }] }, mbid)).toBe("https://r2.theaudiodb.com/t.jpg");
        expect(audioDbThumb({ artists: [{ strMusicBrainzID: "other", strArtistThumb: "https://r2.theaudiodb.com/t.jpg" }] }, mbid)).toBeNull();
        expect(audioDbThumb({ artists: null }, mbid)).toBeNull();
        expect(audioDbThumb({ artists: [{ strArtistThumb: null }] }, mbid)).toBeNull();
        expect(audioDbThumb(null, mbid)).toBeNull();
    });
});

describe("cover original", () => {
    test("the original is the front image without a size", () => {
        expect(coverOriginalUrl("release-group", "ABCDEF01-0000-4000-8000-000000000000")).toBe("https://coverartarchive.org/release-group/abcdef01-0000-4000-8000-000000000000/front");
    });
});
