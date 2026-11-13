import { describe, expect, test } from "bun:test";
import { cleanDiscogsArtist, collectionToAlbums } from "../server/utils/discogsCollection";

describe("Discogs collection", () => {
    test("artist numbering, name variations and Various", () => {
        expect(cleanDiscogsArtist("Nirvana (2)")).toBe("Nirvana");
        expect(cleanDiscogsArtist("Prince*")).toBe("Prince");
        expect(cleanDiscogsArtist("Various")).toBe("Various Artists");
    });

    test("one album per title + artist, credits joined", () => {
        const albums = collectionToAlbums([
            { basic_information: { title: "Nevermind", artists: [{ name: "Nirvana (2)" }] } },
            { basic_information: { title: "nevermind", artists: [{ name: "Nirvana" }] } },
            { basic_information: { title: "Watch the Throne", artists: [{ name: "Jay-Z", join: "&" }, { name: "Kanye West" }] } },
            { basic_information: { title: "", artists: [{ name: "X" }] } }
        ], 10);
        expect(albums).toEqual([
            { title: "Nevermind", artist: "Nirvana" },
            { title: "Watch the Throne", artist: "Jay-Z & Kanye West" }
        ]);
    });

    test("capped", () => {
        const many = Array.from({ length: 5 }, (_, i) => ({ basic_information: { title: `A${i}`, artists: [{ name: "B" }] } }));
        expect(collectionToAlbums(many, 3)).toHaveLength(3);
    });
});
