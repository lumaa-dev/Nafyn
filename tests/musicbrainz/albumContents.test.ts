import { describe, expect, test } from "bun:test";
import { getAlbumContents } from "../../server/utils/albumContents";

const artist = (id: string, name: string, disambiguation = "") => ({ id, name, "sort-name": name, disambiguation });
const lead = artist("a-lead", "Lead", "the band");
const guest = artist("a-guest", "Guest");
const other = artist("a-other", "Other");
const various = artist("89ad4ac3-39f7-470e-963a-56509c546377", "Various Artists");

function client(releaseGroupCredit: unknown[], tracks: unknown[]) {
    return {
        lookup: async () => ({ id: "rg-1", title: "The Album", "primary-type": "Album", "first-release-date": "2027-04-09", "artist-credit": releaseGroupCredit }),
        browse: async () => ({
            releases: [{
                id: "rel-1", title: "The Album", status: "Official", media: [
                    { position: 1, format: "Digital Media", tracks: tracks.slice(0, 2) },
                    { position: 2, format: "Digital Media", tracks: tracks.slice(2) }
                ]
            }]
        })
    } as never;
}

const track = (id: string, title: string, credit: unknown[] | undefined, length = 180000) => ({
    title, length, "artist-credit": credit, recording: { id, title, length, "first-release-date": "2027-03-01" }
});

describe("what is on an album", () => {
    const tracks = [
        track("t1", "One", [{ name: "Lead", artist: lead, joinphrase: "" }]),
        track("t2", "Two", [{ name: "Lead", artist: lead, joinphrase: " feat. " }, { name: "Guest", artist: guest, joinphrase: "" }]),
        track("t3", "Three", [{ name: "Other", artist: other, joinphrase: "" }]),
        track("t4", "Four", undefined)
    ];

    test("every track, across discs, in order", async () => {
        const contents = (await getAlbumContents(client([{ name: "Lead", artist: lead }], tracks), "rg-1"))!;
        expect(contents.tracks.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
        expect(contents).toMatchObject({ albumId: "rg-1", albumTitle: "The Album", albumType: "album", releaseId: "rel-1", releaseDate: "2027-04-09" });
    });

    test("every credited artist once, featurings included, the album's own first", async () => {
        const contents = (await getAlbumContents(client([{ name: "Lead", artist: lead }], tracks), "rg-1"))!;
        expect(contents.artists.map((a) => a.id)).toEqual(["a-lead", "a-guest", "a-other"]);
        expect(contents.artists[0]!.disambiguation).toBe("the band");
        expect(contents.artists[1]!.disambiguation).toBeNull();
    });

    test("a track credit reads as written, one without falls back to its recording's", async () => {
        const contents = (await getAlbumContents(client([{ name: "Lead", artist: lead }], tracks), "rg-1"))!;
        expect(contents.tracks[1]!.artist).toEqual({ name: "Lead feat. Guest", id: "a-lead" });
        expect(contents.tracks[3]!.artist).toEqual({ name: "Lead", id: "a-lead" });
    });

    test("'Various Artists' is not somebody on the album", async () => {
        const contents = (await getAlbumContents(client([{ name: "Various Artists", artist: various }], tracks), "rg-1"))!;
        expect(contents.artists.map((a) => a.id)).toEqual(["a-lead", "a-guest", "a-other"]);
    });

    test("no usable release: null", async () => {
        const empty = { lookup: async () => ({ id: "rg-1", title: "x" }), browse: async () => ({ releases: [] }) } as never;
        expect(await getAlbumContents(empty, "rg-1")).toBeNull();
    });
});
