import { describe, expect, test } from "bun:test";
import {
    audioDbArtist, commonsImageUrl, listenBrainzListeners, usableImageUrl, wikidataId, wikidataIdFromRelations,
    wikidataImageFile
} from "../server/utils/artistImageParse";
import { coverOriginalUrl } from "../server/utils/coverUrl";

const RADIOHEAD = "a74b1b7f-71a5-4011-9441-d0b5e4122711";

describe("wikidataId", () => {
    test("the item ID, whatever the spelling", () => {
        expect(wikidataId("https://www.wikidata.org/wiki/Q44190")).toBe("Q44190");
        expect(wikidataId("http://wikidata.org/entity/Q44190")).toBe("Q44190");
    });

    test("anything that is not a Wikidata item is refused", () => {
        expect(wikidataId("https://evil.example/wiki/Q44190")).toBeNull();
        expect(wikidataId("https://www.wikidata.org.evil.example/wiki/Q44190")).toBeNull();
        expect(wikidataId("https://www.wikidata.org/wiki/Property:P18")).toBeNull();
        expect(wikidataId("file:///etc/passwd")).toBeNull();
        expect(wikidataId("not a url")).toBeNull();
        expect(wikidataId(null)).toBeNull();
    });
});

describe("wikidataIdFromRelations", () => {
    test("takes the wikidata relation among the artist's links", () => {
        expect(wikidataIdFromRelations([
            { type: "official homepage", url: { resource: "https://example.org" } },
            { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q44190" } }
        ])).toBe("Q44190");
    });

    test("none, or one that is not an item: null", () => {
        expect(wikidataIdFromRelations([])).toBeNull();
        expect(wikidataIdFromRelations(undefined)).toBeNull();
        expect(wikidataIdFromRelations([{ type: "wikidata", url: { resource: "https://example.org/wiki/Q1" } }])).toBeNull();
    });
});

describe("images", () => {
    test("non-https URLs are not pictures", () => {
        expect(usableImageUrl("http://example.org/a.jpg")).toBeNull();
        expect(usableImageUrl("not a url")).toBeNull();
        expect(usableImageUrl("https://r2.theaudiodb.com/t.jpg")).toBe("https://r2.theaudiodb.com/t.jpg");
    });

    test("Wikidata P18: the first file name, never a path", () => {
        const claim = (value: unknown) => ({ mainsnak: { datavalue: { value } } });
        expect(wikidataImageFile({ claims: { P18: [claim("Radiohead live.jpg"), claim("Other.jpg")] } })).toBe("Radiohead live.jpg");
        expect(wikidataImageFile({ claims: { P18: [claim("../x/y.jpg"), claim("Ok.jpg")] } })).toBe("Ok.jpg");
        expect(wikidataImageFile({ claims: {} })).toBeNull();
        expect(wikidataImageFile(null)).toBeNull();
    });

    test("Commons file URL: spaces as underscores, the rest encoded", () => {
        expect(commonsImageUrl("Radiohead live (2025).jpg")).toBe("https://commons.wikimedia.org/wiki/Special:FilePath/Radiohead_live_(2025).jpg?width=1000");
        expect(commonsImageUrl("A&B?.jpg", 500)).toBe("https://commons.wikimedia.org/wiki/Special:FilePath/A%26B%3F.jpg?width=500");
    });

    test("TheAudioDB: the thumb and bio of the artist with that MusicBrainz ID", () => {
        expect(audioDbArtist({ artists: [{ strMusicBrainzID: RADIOHEAD.toUpperCase(), strArtistThumb: "https://r2.theaudiodb.com/t.jpg", strBiography: " Bio " }] }, RADIOHEAD))
            .toEqual({ image: "https://r2.theaudiodb.com/t.jpg", bio: "Bio", logo: null, tags: { genre: null, style: null, mood: null } });
        expect(audioDbArtist({ artists: [{ strMusicBrainzID: RADIOHEAD, strArtistThumb: null, strBiographyEN: "Old", strBiography: "New" }] }, RADIOHEAD))
            .toEqual({ image: null, bio: "Old", logo: null, tags: { genre: null, style: null, mood: null } });
        expect(audioDbArtist({ artists: [{ strMusicBrainzID: "other", strArtistThumb: "https://r2.theaudiodb.com/t.jpg" }] }, RADIOHEAD)).toBeNull();
        expect(audioDbArtist({ artists: null }, RADIOHEAD)).toBeNull();
        expect(audioDbArtist(null, RADIOHEAD)).toBeNull();
    });

    test("TheAudioDB name search: the first artist", () => {
        expect(audioDbArtist({ artists: [{ strMusicBrainzID: RADIOHEAD, strArtistThumb: "https://r2.theaudiodb.com/t.jpg", strBiography: "" }] }, null))
            .toEqual({ image: "https://r2.theaudiodb.com/t.jpg", bio: null, logo: null, tags: { genre: null, style: null, mood: null } });
    });

    test("TheAudioDB: the logo (https only) and what the artist sounds like", () => {
        const artist = audioDbArtist({ artists: [{
            strMusicBrainzID: RADIOHEAD, strArtistLogo: "https://r2.theaudiodb.com/logo.png",
            strGenre: " Alternative Rock ", strStyle: "Rock/Pop", strMood: "Reflective"
        }] }, RADIOHEAD);
        expect(artist?.logo).toBe("https://r2.theaudiodb.com/logo.png");
        expect(artist?.tags).toEqual({ genre: "alternative rock", style: "rock/pop", mood: "reflective" });
        expect(audioDbArtist({ artists: [{ strMusicBrainzID: RADIOHEAD, strArtistLogo: "http://r2.theaudiodb.com/logo.png" }] }, RADIOHEAD)?.logo).toBeNull();
    });
});

describe("listeners", () => {
    test("ListenBrainz popularity: the user count of that artist", () => {
        expect(listenBrainzListeners([{ artist_mbid: RADIOHEAD, total_listen_count: 134659628, total_user_count: 461120 }], RADIOHEAD.toUpperCase())).toBe(461120);
        expect(listenBrainzListeners([{ artist_mbid: RADIOHEAD, total_listen_count: null, total_user_count: null }], RADIOHEAD)).toBeNull();
        expect(listenBrainzListeners([{ artist_mbid: "other", total_user_count: 3 }], RADIOHEAD)).toBeNull();
        expect(listenBrainzListeners({ error: "x" }, RADIOHEAD)).toBeNull();
    });
});

describe("cover original", () => {
    test("the original is the front image without a size", () => {
        expect(coverOriginalUrl("release-group", "ABCDEF01-0000-4000-8000-000000000000")).toBe("https://coverartarchive.org/release-group/abcdef01-0000-4000-8000-000000000000/front");
    });
});
