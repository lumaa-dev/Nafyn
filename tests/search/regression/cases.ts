// The regression set: tricky real searches whose MusicBrainz and Cover Art Archive responses are recorded
// (`bun run search:record`) and replayed by regression.test.ts, so the suite never touches the network.
// Cases about the same artist or script share one fixture file (`fixture`): a request two cases both send is
// recorded once. Changing a case's input changes the queries the engine sends: re-record its fixture.

import type { SearchInput } from "../../../server/utils/search/engine";

export interface RegressionCase {
    name: string,
    /** The fixture file (fixtures/<fixture>.json) its responses are replayed from. */
    fixture: string,
    kind: "album" | "track",
    input: SearchInput
}

export const CASES: RegressionCase[] = [
    // self-titled debut vs. the numbered sequels by the same artist
    { name: "debut-vs-sequel", fixture: "led-zeppelin", kind: "album", input: { title: "Led Zeppelin", artist: "Led Zeppelin" } },
    { name: "debut-vs-sequel-freetext", fixture: "led-zeppelin", kind: "album", input: { q: "Led Zeppelin" } },
    // remaster vs original
    { name: "remaster-default", fixture: "editions", kind: "album", input: { title: "Abbey Road", artist: "The Beatles" } },
    { name: "remaster-asked", fixture: "editions", kind: "album", input: { title: "Abbey Road (Remastered)", artist: "The Beatles" } },
    // "Best of" exclusion: Queen's catalogue is full of greatest-hits compilations
    { name: "best-of-excluded", fixture: "editions", kind: "album", input: { artist: "Queen" } },
    { name: "best-of-asked", fixture: "editions", kind: "album", input: { title: "Greatest Hits", artist: "Queen" } },
    // scripts
    { name: "japanese", fixture: "japanese", kind: "album", input: { title: "First Love", artist: "宇多田ヒカル" } },
    { name: "japanese-latin-artist", fixture: "japanese", kind: "album", input: { title: "First Love", artist: "Utada Hikaru" } },
    { name: "cyrillic", fixture: "other-scripts", kind: "album", input: { title: "Группа крови", artist: "Кино" } },
    { name: "cyrillic-latin-artist", fixture: "other-scripts", kind: "album", input: { title: "Вендетта", artist: "Zemfira" } },
    // a non-Latin work typed in Latin letters: MusicBrainz holds the romanization as the track title on a
    // Latin-script release (二十歳の恋 = "Hatachi No Koi"), found through `alias`
    { name: "romanized-track", fixture: "japanese", kind: "track", input: { title: "Hatachi no Koi" } },
    { name: "romanized-track-typo", fixture: "japanese", kind: "track", input: { title: "Hatashi no Koi" } },
    { name: "romanized-album", fixture: "japanese", kind: "album", input: { title: "Lamp Genso", artist: "Lamp" } },
    // romaji for a title MusicBrainz only has in kana (ゆめうつつ)
    { name: "romaji-as-kana", fixture: "japanese", kind: "track", input: { title: "Yume Utsutsu", artist: "Lamp" } },
    // a track whose title mixes kana, kanji and Latin words (スキスキDieスキ超Ayeシテル), by an artist (宝鐘マリン) whose
    // Latin spelling is only an alias; MusicBrainz holds no searchable Latin title for it, so the artist's
    // catalogue is scored through its romanization
    { name: "japanese-mixed-track", fixture: "japanese", kind: "track", input: { title: "スキスキDieスキ超Ayeシテル" } },
    { name: "japanese-artist", fixture: "japanese", kind: "track", input: { q: "宝鐘マリン" } },
    { name: "romanized-track-latin-artist", fixture: "japanese", kind: "track", input: { title: "Suki Suki Die Suki Cho Aye Shiteru", artist: "Houshou Marine" } },
    // one album, searched under its Latin and its Japanese title: both must land on the same release-group
    { name: "album-latin-title", fixture: "japanese", kind: "album", input: { q: "Ahoy!! You're All Pirates♡" } },
    { name: "album-japanese-title", fixture: "japanese", kind: "album", input: { q: "Ahoy!! キミたちみんなパイレーツ♡" } },
    // free text that is the artist and the title in one string, in any order, with words skipped and typos:
    // One Simple Trick by Lovejoy, Chimera by Panchiko, "A season in the dark, a bottomless trench" by Feldup
    { name: "lovejoy-title-only", fixture: "free-text", kind: "album", input: { q: "one simple trick" } },
    { name: "lovejoy-artist-title", fixture: "free-text", kind: "album", input: { q: "lovejoy one simple trick" } },
    { name: "lovejoy-skipped-word", fixture: "free-text", kind: "album", input: { q: "lovejoy one trick" } },
    { name: "lovejoy-title-artist", fixture: "free-text", kind: "album", input: { q: "one simple lovejoy" } },
    { name: "panchiko-title-artist", fixture: "free-text", kind: "album", input: { q: "chimera panchiko" } },
    { name: "panchiko-artist-title", fixture: "free-text", kind: "album", input: { q: "panchiko chimera" } },
    // 148 official release-groups are called "Chimera": nothing but their date tells them apart
    { name: "panchiko-bare-title", fixture: "free-text", kind: "album", input: { q: "chimera" } },
    { name: "feldup-artist-first-half", fixture: "free-text", kind: "album", input: { q: "feldup season in the dark" } },
    { name: "feldup-second-half-artist", fixture: "free-text", kind: "album", input: { q: "bottomless trench feldup" } },
    { name: "feldup-split-word-typo", fixture: "free-text", kind: "album", input: { q: "feldup bottom less tranch" } },
    { name: "feldup-first-half", fixture: "free-text", kind: "album", input: { q: "a season in the dark" } },
    { name: "feldup-second-half-typo", fixture: "free-text", kind: "album", input: { q: "a bottomles trench" } },
    // accents
    { name: "accented", fixture: "other-scripts", kind: "album", input: { title: "Dr. Feelgood", artist: "Mötley Crüe" } },
    { name: "unaccented", fixture: "other-scripts", kind: "album", input: { title: "Dr. Feelgood", artist: "Motley Crue" } },
    // codes
    { name: "upc-correct", fixture: "codes", kind: "album", input: { title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "075678263323" } },
    { name: "upc-unknown", fixture: "codes", kind: "album", input: { title: "Led Zeppelin II", artist: "Led Zeppelin", upc: "012345678905" } },
    { name: "isrc-correct", fixture: "codes", kind: "track", input: { title: "Blow Your Mind (Mwah)", artist: "Dua Lipa", isrc: "GBAHT1600302" } },
    // tracks: live bootlegs of the same song must not come back
    { name: "track-bootleg", fixture: "led-zeppelin", kind: "track", input: { title: "Stairway to Heaven", artist: "Led Zeppelin" } },
    { name: "track-artist-dash-title", fixture: "led-zeppelin", kind: "track", input: { q: "Led Zeppelin - Stairway to Heaven" } }
];
