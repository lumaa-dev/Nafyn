// The regression set: tricky real searches whose MusicBrainz and Cover Art Archive responses are recorded
// (`bun run search:record`) and replayed by regression.test.ts, so the suite never touches the network.
// Changing a case's input changes the queries the engine sends: re-record it.

import type { SearchInput } from "../../server/utils/search/engine";

export interface RegressionCase {
    name: string,
    kind: "album" | "track",
    input: SearchInput
}

export const CASES: RegressionCase[] = [
    // self-titled debut vs. the numbered sequels by the same artist
    { name: "debut-vs-sequel", kind: "album", input: { title: "Led Zeppelin", artist: "Led Zeppelin" } },
    { name: "debut-vs-sequel-freetext", kind: "album", input: { q: "Led Zeppelin" } },
    // remaster vs original
    { name: "remaster-default", kind: "album", input: { title: "Abbey Road", artist: "The Beatles" } },
    { name: "remaster-asked", kind: "album", input: { title: "Abbey Road (Remastered)", artist: "The Beatles" } },
    // "Best of" exclusion: Queen's catalogue is full of greatest-hits compilations
    { name: "best-of-excluded", kind: "album", input: { artist: "Queen" } },
    { name: "best-of-asked", kind: "album", input: { title: "Greatest Hits", artist: "Queen" } },
    // scripts
    { name: "japanese", kind: "album", input: { title: "First Love", artist: "宇多田ヒカル" } },
    { name: "japanese-latin-artist", kind: "album", input: { title: "First Love", artist: "Utada Hikaru" } },
    { name: "cyrillic", kind: "album", input: { title: "Группа крови", artist: "Кино" } },
    { name: "cyrillic-latin-artist", kind: "album", input: { title: "Вендетта", artist: "Zemfira" } },
    // accents
    { name: "accented", kind: "album", input: { title: "Dr. Feelgood", artist: "Mötley Crüe" } },
    { name: "unaccented", kind: "album", input: { title: "Dr. Feelgood", artist: "Motley Crue" } },
    // codes
    { name: "upc-correct", kind: "album", input: { title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "075678263323" } },
    { name: "upc-unknown", kind: "album", input: { title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "012345678905" } },
    { name: "isrc-correct", kind: "track", input: { title: "Blow Your Mind (Mwah)", artist: "Dua Lipa", isrc: "GBAHT1600302" } },
    // tracks: live bootlegs of the same song must not come back
    { name: "track-bootleg", kind: "track", input: { title: "Stairway to Heaven", artist: "Led Zeppelin" } },
    { name: "track-artist-dash-title", kind: "track", input: { q: "Led Zeppelin - Stairway to Heaven" } }
];
