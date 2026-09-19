// dev-only "Sample Data" mode: fills a user's library, playlists and listening insights with a fixed
// catalog of real songs/albums/artists so the app can be demoed/screenshotted without a working slskd
// instance. Gated to non-production at both the API route (server/api/v1/user/sample-data.*.ts, which
// 404s outright when `import.meta.dev` is false) and here, defensively.
//
// Every id in the catalog is derived deterministically from its (artist, album, title) via stableId(),
// never randomUUID(). That makes the whole thing idempotent: enabling twice reuses the same media/playlist/
// event rows (INSERT IGNORE) instead of piling up duplicates, and disabling can recompute exactly which
// rows to remove without a bookkeeping table.
import { createHash } from "node:crypto";
import { mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { extname, join } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import { getLibrariesDb } from "./db";
import { insertMedia, addLibraryEntry, findLibraryEntry, getMediaId, deleteLibraryEntryForUser, type MediaRow } from "./library";
import { createPlaylist, addEntries, getPlaylistById, deletePlaylist } from "./playlists";
import { insertPlayEvents, countEventsForUser } from "./playEvents";
import { setHistoryEnabled } from "./insightsSettings";
import { rollupDay, rollupMonth, rollupYear } from "./insightsAggregate";
import { rebuildReplayMix, rebuildAllTime } from "./replayMix";
import { snapshotYear } from "./insightsSnapshot";
import { deleteReelsForUser } from "./insightsReel";
import { localDateKey, startOfLocalDay, DAY_MS, type PlaySource } from "~~/server/utils/insightsPeriod";
import type { PlayEventInput } from "~~/server/utils/insightsValidate";

function stableId(seed: string): string {
    const hex = createHash("md5").update(seed).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// a stable pseudo-random float in [0, 1) derived from a seed string - used instead of Math.random() so
// enabling sample data twice for the same user produces the exact same listening history rather than
// silently doubling it via a fresh random shuffle every time
function hashFloat(seed: string): number {
    const hex = createHash("md5").update(seed).digest("hex").slice(0, 8);
    return parseInt(hex, 16) / 0xffffffff;
}

// dev-only: sample data has no real download to source audio from, but a working reel render and in-app
// playback both need actual bytes on disk to read. `/music` is never bundled into a production build (it's
// this install's own downloaded/imported library), so borrowing whatever real audio files are already
// sitting there - purely so ffmpeg and the player have something real to open - is safe as long as it never
// touches those files themselves. See ensureSampleAudioLink() for how that's kept safe.
const MUSIC_DIR = join(process.cwd(), "music");
const AUDIO_EXTENSIONS = new Set([".mp3", ".flac", ".m4a", ".ogg", ".wav"]);

async function discoverMusicFiles(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await discoverMusicFiles(full));
        } else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
            files.push(full);
        }
    }
    return files;
}

function pickSourceFile(musicFiles: string[], mediaId: string): string {
    const index = Math.min(musicFiles.length - 1, Math.floor(hashFloat(`sample-file:${mediaId}`) * musicFiles.length));
    return musicFiles[index]!;
}

const durationCache = new Map<string, number>();

/** real duration of a file in seconds, via ffprobe - 0 if it can't be read (missing ffprobe, corrupt file, ...) */
function probeDurationSeconds(filePath: string): Promise<number> {
    const cached = durationCache.get(filePath);
    if (cached !== undefined) return Promise.resolve(cached);

    return new Promise((resolvePromise) => {
        ffmpeg.ffprobe(filePath, (err, data) => {
            const seconds = !err && data?.format?.duration ? Math.round(data.format.duration) : 0;
            durationCache.set(filePath, seconds);
            resolvePromise(seconds);
        });
    });
}

/**
 * Points a sample track's library entry at a real audio file without ever putting that file itself at risk.
 *
 * The library's dedup model deletes a media row's `filePath` once the last `library_entries` row referencing
 * that *media id* disappears (see deleteLibraryEntryForUser in library.ts). If a sample media row's filePath
 * were the real file's path directly, removing that one sample track (via the sample-data toggle, or even
 * just the ordinary "remove from library" button) would delete a file other, real media rows might depend on
 * for playback - this install's actual music, gone because a demo track shared its path.
 *
 * A symlink breaks that link cleanly: `music/sample-<mediaId>.<ext>` is a file the sample-data feature owns
 * outright, one per sample track, so the normal deletion path removes only the link (POSIX unlink on a
 * symlink never touches its target) while every reader that opens it - the stream route, Subsonic, ffmpeg -
 * follows it to the real bytes exactly like any other file.
 */
async function ensureSampleAudioLink(mediaId: string, sourceFile: string): Promise<string> {
    await mkdir(MUSIC_DIR, { recursive: true });
    const linkPath = join(MUSIC_DIR, `sample-${mediaId}${extname(sourceFile) || ".mp3"}`);

    try {
        if (await readlink(linkPath) === sourceFile) return linkPath;
        await rm(linkPath, { force: true });
    } catch {
        // no existing symlink there (or it's not a symlink) - fall through and create one
    }

    await symlink(sourceFile, linkPath);
    return linkPath;
}

interface TrackDef {
    artist: string,
    title: string,
    album: string | null,
    albumType: "album" | "ep" | null,
    trackNumber: number | null,
    year: number,
    durationSec: number
}

// real songs by real artists only - no invented names. Durations are approximate (this is demo data, not a
// metadata source of truth). Cover art is left null: fetching real artwork would mean hotlinking third-party
// images at runtime, which is more risk than a placeholder-cover demo needs.
const CATALOG: TrackDef[] = [
    // Tyler, The Creator
    { artist: "Tyler, The Creator", title: "EARFQUAKE", album: "IGOR", albumType: "album", trackNumber: 2, year: 2019, durationSec: 190 },
    { artist: "Tyler, The Creator", title: "NEW MAGIC WAND", album: "IGOR", albumType: "album", trackNumber: 7, year: 2019, durationSec: 194 },
    { artist: "Tyler, The Creator", title: "A BOY IS A GUN*", album: "IGOR", albumType: "album", trackNumber: 5, year: 2019, durationSec: 251 },
    { artist: "Tyler, The Creator", title: "GONE, GONE / THANK YOU", album: "IGOR", albumType: "album", trackNumber: 9, year: 2019, durationSec: 248 },
    { artist: "Tyler, The Creator", title: "WUSYANAME", album: "Call Me If You Get Lost", albumType: "album", trackNumber: 3, year: 2021, durationSec: 161 },
    { artist: "Tyler, The Creator", title: "LUMBERJACK", album: "Call Me If You Get Lost", albumType: "album", trackNumber: 2, year: 2021, durationSec: 184 },
    { artist: "Tyler, The Creator", title: "SWEET / I THOUGHT YOU WANTED TO DANCE", album: "Call Me If You Get Lost", albumType: "album", trackNumber: 13, year: 2021, durationSec: 285 },
    { artist: "Tyler, The Creator", title: "MASSA", album: "Call Me If You Get Lost", albumType: "album", trackNumber: 15, year: 2021, durationSec: 313 },

    // Feldup (mostly non-album singles)
    { artist: "Feldup", title: "Xtc", album: null, albumType: null, trackNumber: null, year: 2020, durationSec: 148 },
    { artist: "Feldup", title: "Adderall", album: null, albumType: null, trackNumber: null, year: 2021, durationSec: 132 },
    { artist: "Feldup", title: "Water", album: null, albumType: null, trackNumber: null, year: 2021, durationSec: 141 },
    { artist: "Feldup", title: "Overdrive", album: null, albumType: null, trackNumber: null, year: 2022, durationSec: 156 },
    { artist: "Feldup", title: "GTA", album: null, albumType: null, trackNumber: null, year: 2022, durationSec: 138 },
    { artist: "Feldup", title: "Comedown", album: null, albumType: null, trackNumber: null, year: 2023, durationSec: 163 },

    // Lovejoy
    { artist: "Lovejoy", title: "Call Me Maybe Sometime", album: "Are You Alright?", albumType: "ep", trackNumber: 1, year: 2021, durationSec: 202 },
    { artist: "Lovejoy", title: "Perfume", album: "Are You Alright?", albumType: "ep", trackNumber: 3, year: 2021, durationSec: 219 },
    { artist: "Lovejoy", title: "Overstimulated", album: "Are You Alright?", albumType: "ep", trackNumber: 4, year: 2021, durationSec: 175 },
    { artist: "Lovejoy", title: "Snow Angel", album: "Are You Alright?", albumType: "ep", trackNumber: 5, year: 2021, durationSec: 240 },
    { artist: "Lovejoy", title: "Sex Sells", album: "Wake Up & It's Over", albumType: "album", trackNumber: 2, year: 2022, durationSec: 208 },
    { artist: "Lovejoy", title: "Portrait Of A Blank Slate", album: "Wake Up & It's Over", albumType: "album", trackNumber: 3, year: 2022, durationSec: 233 },
    { artist: "Lovejoy", title: "Blue Cheese", album: "Wake Up & It's Over", albumType: "album", trackNumber: 6, year: 2022, durationSec: 197 },
    { artist: "Lovejoy", title: "Wisegoth", album: "Wake Up & It's Over", albumType: "album", trackNumber: 9, year: 2022, durationSec: 221 },

    // James Marriott
    { artist: "James Marriott", title: "Emily", album: "Are We Having Fun Yet?", albumType: "album", trackNumber: 1, year: 2023, durationSec: 189 },
    { artist: "James Marriott", title: "Big Fan", album: "Are We Having Fun Yet?", albumType: "album", trackNumber: 2, year: 2023, durationSec: 176 },
    { artist: "James Marriott", title: "Cold in California", album: "Are We Having Fun Yet?", albumType: "album", trackNumber: 4, year: 2023, durationSec: 203 },
    { artist: "James Marriott", title: "Cannibal", album: "Are We Having Fun Yet?", albumType: "album", trackNumber: 6, year: 2023, durationSec: 195 },
    { artist: "James Marriott", title: "Cuffing Season", album: "Are We Having Fun Yet?", albumType: "album", trackNumber: 7, year: 2023, durationSec: 182 },
    { artist: "James Marriott", title: "Play Fake Music", album: "Are We Having Fun Yet?", albumType: "album", trackNumber: 9, year: 2023, durationSec: 210 },
    { artist: "James Marriott", title: "Über", album: "Cool Guys Don't Dance", albumType: "ep", trackNumber: 2, year: 2021, durationSec: 168 },
    { artist: "James Marriott", title: "Rockstars Don't Sing About Heartbreak", album: "Cool Guys Don't Dance", albumType: "ep", trackNumber: 4, year: 2021, durationSec: 199 },

    // Basement
    { artist: "Basement", title: "Whole", album: "Colourmeinkindness", albumType: "album", trackNumber: 1, year: 2012, durationSec: 195 },
    { artist: "Basement", title: "Covet", album: "Colourmeinkindness", albumType: "album", trackNumber: 3, year: 2012, durationSec: 178 },
    { artist: "Basement", title: "Spoiled319", album: "Colourmeinkindness", albumType: "album", trackNumber: 5, year: 2012, durationSec: 163 },
    { artist: "Basement", title: "S.L.A.B City", album: "Colourmeinkindness", albumType: "album", trackNumber: 8, year: 2012, durationSec: 205 },
    { artist: "Basement", title: "Adelaide", album: "Promise Everything", albumType: "album", trackNumber: 2, year: 2014, durationSec: 220 },
    { artist: "Basement", title: "Ares", album: "Promise Everything", albumType: "album", trackNumber: 5, year: 2014, durationSec: 188 },
    { artist: "Basement", title: "Aquasun", album: "Promise Everything", albumType: "album", trackNumber: 7, year: 2014, durationSec: 172 },
    { artist: "Basement", title: "Nova", album: "Promise Everything", albumType: "album", trackNumber: 10, year: 2014, durationSec: 231 },

    // The Strokes
    { artist: "The Strokes", title: "Last Nite", album: "Is This It", albumType: "album", trackNumber: 5, year: 2001, durationSec: 193 },
    { artist: "The Strokes", title: "Someday", album: "Is This It", albumType: "album", trackNumber: 6, year: 2001, durationSec: 175 },
    { artist: "The Strokes", title: "Hard to Explain", album: "Is This It", albumType: "album", trackNumber: 2, year: 2001, durationSec: 206 },
    { artist: "The Strokes", title: "The Modern Age", album: "Is This It", albumType: "album", trackNumber: 4, year: 2001, durationSec: 216 },
    { artist: "The Strokes", title: "Reptilia", album: "Room on Fire", albumType: "album", trackNumber: 3, year: 2003, durationSec: 213 },
    { artist: "The Strokes", title: "12:51", album: "Room on Fire", albumType: "album", trackNumber: 2, year: 2003, durationSec: 152 },
    { artist: "The Strokes", title: "The End Has No End", album: "Room on Fire", albumType: "album", trackNumber: 6, year: 2003, durationSec: 191 },
    { artist: "The Strokes", title: "Under Control", album: "Room on Fire", albumType: "album", trackNumber: 8, year: 2003, durationSec: 189 },

    // The Voidz
    { artist: "The Voidz", title: "Leave It in My Dreams", album: "Virtue", albumType: "album", trackNumber: 2, year: 2018, durationSec: 235 },
    { artist: "The Voidz", title: "All Wordz Are Made Up", album: "Virtue", albumType: "album", trackNumber: 6, year: 2018, durationSec: 254 },
    { artist: "The Voidz", title: "Pyramid of Bones", album: "Virtue", albumType: "album", trackNumber: 10, year: 2018, durationSec: 268 },
    { artist: "The Voidz", title: "QYURRYUS", album: "Virtue", albumType: "album", trackNumber: 3, year: 2018, durationSec: 331 },
    { artist: "The Voidz", title: "Human Sadness", album: "Tyranny", albumType: "album", trackNumber: 1, year: 2014, durationSec: 626 },
    { artist: "The Voidz", title: "Where No Eagles Fly", album: "Tyranny", albumType: "album", trackNumber: 6, year: 2014, durationSec: 244 },
    { artist: "The Voidz", title: "Dameika Rules", album: "Tyranny", albumType: "album", trackNumber: 12, year: 2014, durationSec: 258 },
    { artist: "The Voidz", title: "M.utually A.ssured D.estruction", album: "Tyranny", albumType: "album", trackNumber: 3, year: 2014, durationSec: 271 },

    // Vacations
    { artist: "Vacations", title: "Young", album: "Vibes", albumType: "album", trackNumber: 1, year: 2017, durationSec: 209 },
    { artist: "Vacations", title: "Aces", album: "Vibes", albumType: "album", trackNumber: 4, year: 2017, durationSec: 197 },
    { artist: "Vacations", title: "Telephone Call", album: "Vibes", albumType: "album", trackNumber: 6, year: 2017, durationSec: 184 },
    { artist: "Vacations", title: "Puzzle", album: "Vibes", albumType: "album", trackNumber: 9, year: 2017, durationSec: 226 },
    { artist: "Vacations", title: "Sundial", album: "Melia", albumType: "album", trackNumber: 2, year: 2020, durationSec: 201 },
    { artist: "Vacations", title: "Wildflower", album: "Melia", albumType: "album", trackNumber: 5, year: 2020, durationSec: 218 },
    { artist: "Vacations", title: "Two Steps", album: "Melia", albumType: "album", trackNumber: 7, year: 2020, durationSec: 192 },
    { artist: "Vacations", title: "Take It Easy", album: "Melia", albumType: "album", trackNumber: 10, year: 2020, durationSec: 205 },

    // Oliver Tree
    { artist: "Oliver Tree", title: "Alien Boy", album: "Ugly Is Beautiful", albumType: "album", trackNumber: 2, year: 2020, durationSec: 202 },
    { artist: "Oliver Tree", title: "Life Goes On", album: "Ugly Is Beautiful", albumType: "album", trackNumber: 5, year: 2020, durationSec: 189 },
    { artist: "Oliver Tree", title: "Miss You", album: "Ugly Is Beautiful", albumType: "album", trackNumber: 8, year: 2020, durationSec: 195 },
    { artist: "Oliver Tree", title: "Cowboys Don't Cry", album: "Ugly Is Beautiful", albumType: "album", trackNumber: 11, year: 2020, durationSec: 211 },
    { artist: "Oliver Tree", title: "Freaky", album: "Cowboy Tears", albumType: "album", trackNumber: 1, year: 2022, durationSec: 178 },
    { artist: "Oliver Tree", title: "Hurt", album: "Cowboy Tears", albumType: "album", trackNumber: 4, year: 2022, durationSec: 200 },
    { artist: "Oliver Tree", title: "Playground", album: "Cowboy Tears", albumType: "album", trackNumber: 6, year: 2022, durationSec: 186 },
    { artist: "Oliver Tree", title: "1993", album: "Cowboy Tears", albumType: "album", trackNumber: 9, year: 2022, durationSec: 193 },

    // beabadoobee
    { artist: "beabadoobee", title: "Care", album: "Fake It Flowers", albumType: "album", trackNumber: 2, year: 2020, durationSec: 202 },
    { artist: "beabadoobee", title: "Worth It", album: "Fake It Flowers", albumType: "album", trackNumber: 5, year: 2020, durationSec: 187 },
    { artist: "beabadoobee", title: "Sorry", album: "Fake It Flowers", albumType: "album", trackNumber: 8, year: 2020, durationSec: 179 },
    { artist: "beabadoobee", title: "Dye It Red", album: "Fake It Flowers", albumType: "album", trackNumber: 11, year: 2020, durationSec: 195 },
    { artist: "beabadoobee", title: "10:36", album: "Beatopia", albumType: "album", trackNumber: 3, year: 2022, durationSec: 168 },
    { artist: "beabadoobee", title: "Talk", album: "Beatopia", albumType: "album", trackNumber: 6, year: 2022, durationSec: 191 },
    { artist: "beabadoobee", title: "See you Soon", album: "Beatopia", albumType: "album", trackNumber: 9, year: 2022, durationSec: 226 },
    { artist: "beabadoobee", title: "Glue Song", album: "Beatopia", albumType: "album", trackNumber: 15, year: 2022, durationSec: 132 }
];

interface ResolvedTrack extends TrackDef {
    mediaId: string,
    musicbrainzId: string,
    artistMbid: string,
    // "unknown-album" sentinel for singles with no release group, matching the download pipeline's convention
    albumId: string
}

function resolveCatalog(): ResolvedTrack[] {
    return CATALOG.map((t) => ({
        ...t,
        mediaId: stableId(`sample-media:${t.artist}:${t.album ?? ""}:${t.title}`),
        musicbrainzId: stableId(`sample-mbid:${t.artist}:${t.album ?? ""}:${t.title}`),
        artistMbid: stableId(`sample-artist:${t.artist}`),
        albumId: t.album ? stableId(`sample-album:${t.artist}:${t.album}`) : "unknown-album"
    }));
}

interface PlaylistDef {
    name: string,
    description: string | null,
    // matched against catalog entries by exact (artist, title)
    tracks: { artist: string, title: string }[]
}

const PLAYLIST_DEFS: PlaylistDef[] = [
    {
        name: "3am brain rot",
        description: "for when you should be asleep",
        tracks: [
            { artist: "Vacations", title: "Sundial" }, { artist: "beabadoobee", title: "10:36" },
            { artist: "Feldup", title: "Water" }, { artist: "Vacations", title: "Wildflower" },
            { artist: "beabadoobee", title: "Glue Song" }
        ]
    },
    {
        name: "songs that make me feral",
        description: null,
        tracks: [
            { artist: "Tyler, The Creator", title: "NEW MAGIC WAND" }, { artist: "The Voidz", title: "QYURRYUS" },
            { artist: "Basement", title: "Whole" }, { artist: "The Voidz", title: "All Wordz Are Made Up" },
            { artist: "Tyler, The Creator", title: "LUMBERJACK" }
        ]
    },
    {
        name: "definitely not a phase",
        description: "it's called a personality",
        tracks: [
            { artist: "Lovejoy", title: "Perfume" }, { artist: "James Marriott", title: "Emily" },
            { artist: "Lovejoy", title: "Wisegoth" }, { artist: "James Marriott", title: "Über" },
            { artist: "Lovejoy", title: "Overstimulated" }
        ]
    },
    {
        name: "test playlist 2",
        description: "ignore this, testing sort order",
        tracks: [
            { artist: "The Strokes", title: "12:51" }, { artist: "Oliver Tree", title: "Freaky" },
            { artist: "Feldup", title: "Xtc" }
        ]
    },
    {
        name: "it's always 2003 somewhere",
        description: null,
        tracks: [
            { artist: "The Strokes", title: "Reptilia" }, { artist: "The Strokes", title: "The End Has No End" },
            { artist: "The Strokes", title: "Under Control" }, { artist: "The Voidz", title: "Human Sadness" }
        ]
    },
    {
        name: "sad indie hours",
        description: "grey sky music",
        tracks: [
            { artist: "beabadoobee", title: "Care" }, { artist: "beabadoobee", title: "Sorry" },
            { artist: "Vacations", title: "Two Steps" }, { artist: "James Marriott", title: "Cold in California" }
        ]
    },
    {
        name: "car playlist (aux only)",
        description: "do NOT put this on shuffle",
        tracks: [
            { artist: "Tyler, The Creator", title: "WUSYANAME" }, { artist: "Oliver Tree", title: "Alien Boy" },
            { artist: "The Strokes", title: "Last Nite" }, { artist: "Basement", title: "Adelaide" },
            { artist: "Vacations", title: "Young" }
        ]
    },
    {
        name: "no skips fr fr",
        description: null,
        tracks: [
            { artist: "Tyler, The Creator", title: "EARFQUAKE" }, { artist: "beabadoobee", title: "Talk" },
            { artist: "Lovejoy", title: "Call Me Maybe Sometime" }, { artist: "Basement", title: "Nova" },
            { artist: "The Strokes", title: "Someday" }
        ]
    },
    {
        name: "my ex would hate this playlist",
        description: "and that's exactly why it's staying",
        tracks: [
            { artist: "Oliver Tree", title: "1993" }, { artist: "The Voidz", title: "Dameika Rules" },
            { artist: "Feldup", title: "Overdrive" }
        ]
    },
    {
        name: "Untitled Playlist (47)",
        description: "",
        tracks: [
            { artist: "James Marriott", title: "Play Fake Music" }, { artist: "Feldup", title: "GTA" },
            { artist: "Oliver Tree", title: "Hurt" }
        ]
    }
];

function assertDevMode(): void {
    // defence in depth: the API routes already 404 in production before this module is ever reached
    if (!import.meta.dev) {
        throw new Error("Sample data mode is only available in development");
    }
}

/** true if this user currently has sample data loaded - checked via the first catalog track's deterministic media id */
export async function isSampleDataEnabled(userId: string): Promise<boolean> {
    const catalog = resolveCatalog();
    const first = catalog[0];
    if (!first) return false;
    const entry = await findLibraryEntry(userId, first.mediaId);
    return entry !== null;
}

function classify(index: number): { plays: number } {
    if (index % 10 === 0) return { plays: 30 };
    if (index % 3 === 0) return { plays: 12 };
    return { plays: 3 };
}

async function generatePlayHistory(userId: string, catalog: ResolvedTrack[], durationOverrides: Map<string, number>): Promise<void> {
    const now = Date.now();
    const events: PlayEventInput[] = [];

    catalog.forEach((track, trackIndex) => {
        const { plays } = classify(trackIndex);
        // the catalog's durationSec is an approximation (see the CATALOG comment); once a track is backed by
        // a real borrowed audio file (see ensureSampleAudioLink), its actual probed duration is what matters
        // - both for realistic minutes-listened stats and because the reel's excerpt math seeks into the
        // real file by a ratio of this duration, and seeking past a short file's end fails
        const durationSec = durationOverrides.get(track.mediaId) ?? track.durationSec;

        for (let n = 0; n < plays; n++) {
            const seed = `sample-event:${userId}:${track.mediaId}:${n}`;
            // recency-biased day offset: most listens land in the last few months, a long tail reaches back
            // toward a year ago so monthly/yearly charts have something to show
            const dayOffset = Math.floor(365 * Math.pow(hashFloat(`${seed}:day`), 1.6));
            const hour = Math.floor(24 * hashFloat(`${seed}:hour`));
            const minute = Math.floor(60 * hashFloat(`${seed}:minute`));
            const startedAtMs = now - dayOffset * DAY_MS - (23 - hour) * 60 * 60 * 1000 - minute * 60 * 1000;
            if (startedAtMs > now) continue;

            // ~15% of plays are skips (bailed early), the rest are full listens
            const isSkip = hashFloat(`${seed}:skip`) < 0.15;
            const durationMs = isSkip
                ? Math.round(durationSec * 1000 * (0.15 + 0.2 * hashFloat(`${seed}:skipRatio`)))
                : durationSec * 1000;

            const source: PlaySource = hashFloat(`${seed}:source`) < 0.3 ? "playlist" : "library";

            events.push({
                eventId: stableId(seed),
                trackId: track.mediaId,
                playlistId: null,
                startedAtMs,
                durationMs,
                completed: !isSkip,
                source
            });
        }
    });

    // matches the real client's flush batch size (see usePlayTracking.ts), and reuses the exact same
    // ingestion path (enrichment + inline day/month/year rollup) rather than reimplementing it here
    const BATCH = 50;
    for (let i = 0; i < events.length; i += BATCH) {
        await insertPlayEvents(userId, events.slice(i, i + BATCH));
    }
}

export interface SampleDataSummary {
    tracks: number,
    playlists: number,
    playEvents: number
}

export async function enableSampleData(userId: string): Promise<SampleDataSummary> {
    assertDevMode();

    const catalog = resolveCatalog();
    const db = getLibrariesDb();

    // borrow real audio from this install's own /music (never bundled in production - see the module
    // comment above discoverMusicFiles) so the reel render and playback have real bytes to read. Falls back
    // to the old non-existent placeholder path when /music has nothing in it, same as before.
    const musicFiles = await discoverMusicFiles(MUSIC_DIR);
    const durationOverrides = new Map<string, number>();

    // media rows are shared across users by design (see the library dedup model) - only insert what's
    // genuinely missing, and grant this user a library entry for every track either way
    for (const track of catalog) {
        const existing = await getMediaId(track.mediaId);
        if (!existing) {
            let durationSec = track.durationSec;
            if (musicFiles.length > 0) {
                const probed = await probeDurationSeconds(pickSourceFile(musicFiles, track.mediaId));
                if (probed > 0) durationSec = probed;
            }

            const row: Omit<MediaRow, "id" | "addedAt" | "source" | "trackNumber" | "hasCustomCover"> & Partial<Pick<MediaRow, "id" | "source" | "trackNumber" | "hasCustomCover">> = {
                id: track.mediaId,
                musicbrainzId: track.musicbrainzId,
                title: track.title,
                artistName: track.artist,
                artistMbid: track.artistMbid,
                album: track.album,
                albumId: track.albumId,
                albumType: track.albumType,
                coverArt: null,
                releaseDate: Date.UTC(track.year, 0, 1),
                duration: durationSec,
                label: null,
                fingerprint: null,
                amId: null,
                fileSize: null,
                source: "manual",
                trackNumber: track.trackNumber
            };
            await insertMedia(row);
        }

        const desiredFilePath = musicFiles.length > 0
            ? await ensureSampleAudioLink(track.mediaId, pickSourceFile(musicFiles, track.mediaId))
            : `sample-data/${`${track.artist}-${track.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.flac`;

        const owned = await findLibraryEntry(userId, track.mediaId);
        if (!owned) {
            await addLibraryEntry(userId, track.mediaId, desiredFilePath);
        } else if (owned.filePath !== desiredFilePath) {
            // upgrades an entry created before /music had anything in it (or before this feature could
            // borrow real audio at all) to the real file, without disturbing its addedAt/id
            await db.prepare(`UPDATE library_entries SET filePath = ? WHERE id = ?`).run(desiredFilePath, owned.id);
        }
    }

    // whatever's actually stored (freshly probed above, or from an earlier enable) is the duration that
    // matters for the listening history generated below - never the catalog's approximation
    const mediaRows = await db.prepare(`
        SELECT id, duration FROM media WHERE id IN (${catalog.map(() => "?").join(", ")})
    `).all<{ id: string, duration: number }>(...catalog.map((t) => t.mediaId));
    for (const row of mediaRows) durationOverrides.set(row.id, row.duration);

    // playlists: recreated by (deterministic) name lookup so re-enabling doesn't duplicate them
    let playlistCount = 0;
    for (const def of PLAYLIST_DEFS) {
        const existing = await db.prepare(`
            SELECT id FROM playlists WHERE ownerId = ? AND title = ?
        `).get<{ id: string }>(userId, def.name);

        const playlistId = existing?.id ?? (await createPlaylist(userId, def.name, def.description, "private")).id;

        const mediaIds = def.tracks
            .map((ref) => catalog.find((c) => c.artist === ref.artist && c.title === ref.title)?.mediaId)
            .filter((id): id is string => !!id);

        const already = await db.prepare(`SELECT mediaId FROM playlist_entries WHERE playlistId = ?`).all<{ mediaId: string }>(playlistId);
        const alreadyIds = new Set(already.map((r) => r.mediaId));
        const missing = mediaIds.filter((id) => !alreadyIds.has(id));
        if (missing.length > 0) await addEntries(playlistId, missing, userId);

        playlistCount++;
    }

    const tzOffsetMinutes = -new Date().getTimezoneOffset();
    await setHistoryEnabled(userId, true, tzOffsetMinutes);
    await generatePlayHistory(userId, catalog, durationOverrides);

    // insertPlayEvents rolls up day/month/year inline, but never touches the Replay Mix or the year-end
    // snapshot - rebuild/freeze both for every year that now has data, plus the all-time mix.
    //
    // Real accounts only get a snapshot once a year via the December 1st job (snapshotYear() is meant to be
    // "frozen and never rewritten later"), which is exactly why a freshly-generated demo account otherwise
    // 404s on "build my highlight reel": there's no snapshot row for the current, still-open year yet. Sample
    // data is never real listening history, so snapshotting it immediately - current year included - is safe
    // and is what actually lets the reel/story feature be demoed at all. disableSampleData() removes these
    // snapshot rows again (see the stale-year cleanup in recomputeAggregates callers below).
    const years = await db.prepare(`
        SELECT DISTINCT YEAR(started_at) AS y FROM play_events WHERE user_id = ?
    `).all<{ y: number }>(userId);
    for (const { y } of years) {
        await rebuildReplayMix(userId, y);
        await snapshotYear(userId, y, tzOffsetMinutes);
    }
    await rebuildAllTime(userId);

    const total = await countEventsForUser(userId);

    return { tracks: catalog.length, playlists: playlistCount, playEvents: total };
}

/** re-rolls every remaining day/month/year for a user from scratch - used after sample events are removed */
async function recomputeAggregates(userId: string, tzOffsetMinutes: number): Promise<void> {
    const span = await getLibrariesDb().prepare(`
        SELECT MIN(started_at) AS first_at, MAX(started_at) AS last_at FROM play_events WHERE user_id = ?
    `).get<{ first_at: Date | null, last_at: Date | null }>(userId);

    if (!span?.first_at || !span.last_at) {
        // nothing left at all - clear out the now-stale aggregate rows (and any reel file rendered off of
        // them) rather than leaving sample-derived numbers on screen with no events to justify them
        const staleSnapshots = await getLibrariesDb().prepare(`SELECT bucket_year FROM user_year_snapshots WHERE user_id = ?`).all<{ bucket_year: number }>(userId);
        await deleteReelsForUser(userId, staleSnapshots.map((s) => s.bucket_year));

        await getLibrariesDb().prepare(`DELETE FROM user_entity_stats_daily WHERE user_id = ?`).run(userId);
        await getLibrariesDb().prepare(`DELETE FROM user_entity_stats_monthly WHERE user_id = ?`).run(userId);
        await getLibrariesDb().prepare(`DELETE FROM user_entity_stats_yearly WHERE user_id = ?`).run(userId);
        await getLibrariesDb().prepare(`DELETE FROM user_hour_stats_daily WHERE user_id = ?`).run(userId);
        await getLibrariesDb().prepare(`DELETE FROM user_replay_playlists WHERE user_id = ?`).run(userId);
        await getLibrariesDb().prepare(`DELETE FROM user_year_snapshots WHERE user_id = ?`).run(userId);
        return;
    }

    const firstMs = span.first_at.getTime();
    const lastMs = span.last_at.getTime();
    const months = new Set<string>();
    const years = new Set<number>();

    for (let ms = startOfLocalDay(firstMs, tzOffsetMinutes); ms <= lastMs; ms += DAY_MS) {
        const dateKey = localDateKey(ms, tzOffsetMinutes);
        await rollupDay(userId, dateKey, tzOffsetMinutes);
        const [year, month] = dateKey.split("-").map(Number);
        months.add(`${year}-${month}`);
        years.add(year!);
    }
    for (const key of months) {
        const [year, month] = key.split("-").map(Number);
        await rollupMonth(userId, year!, month!, tzOffsetMinutes);
    }
    for (const year of years) {
        await rollupYear(userId, year, tzOffsetMinutes);
        await rebuildReplayMix(userId, year);
    }
    await rebuildAllTime(userId);

    // a snapshot for a year that no longer has any yearly aggregate row was only ever backing sample data
    // (enableSampleData() snapshots every year it touches, including the still-open current one - see there)
    // and just lost the events that justified it; a year with real listening left still has its aggregate
    // row and is left untouched
    const staleSnapshots = await getLibrariesDb().prepare(`
        SELECT s.bucket_year FROM user_year_snapshots s
        LEFT JOIN user_entity_stats_yearly y ON y.user_id = s.user_id AND y.bucket_year = s.bucket_year
        WHERE s.user_id = ? AND y.bucket_year IS NULL
    `).all<{ bucket_year: number }>(userId);

    if (staleSnapshots.length > 0) {
        await deleteReelsForUser(userId, staleSnapshots.map((s) => s.bucket_year));
        for (const { bucket_year: year } of staleSnapshots) {
            await getLibrariesDb().prepare(`DELETE FROM user_year_snapshots WHERE user_id = ? AND bucket_year = ?`).run(userId, year);
        }
    }
}

export async function disableSampleData(userId: string): Promise<void> {
    assertDevMode();

    const catalog = resolveCatalog();
    const db = getLibrariesDb();

    // remove this user's deterministic sample play_events (never other users' or other listening history
    // this user built up themselves - only ids this exact generator could have produced)
    const idsToDelete: string[] = [];
    catalog.forEach((track, trackIndex) => {
        const { plays } = classify(trackIndex);
        for (let n = 0; n < plays; n++) {
            idsToDelete.push(stableId(`sample-event:${userId}:${track.mediaId}:${n}`));
        }
    });
    for (let i = 0; i < idsToDelete.length; i += 500) {
        const chunk = idsToDelete.slice(i, i + 500);
        await db.prepare(`
            DELETE FROM play_events WHERE user_id = ? AND event_id IN (${chunk.map(() => "?").join(", ")})
        `).run(userId, ...chunk);
    }

    // sample playlists, by the same deterministic name list
    for (const def of PLAYLIST_DEFS) {
        const existing = await db.prepare(`SELECT id FROM playlists WHERE ownerId = ? AND title = ?`).get<{ id: string }>(userId, def.name);
        if (existing) {
            const playlist = await getPlaylistById(existing.id);
            if (playlist) await deletePlaylist(playlist.id);
        }
    }

    // library entries - this also drops the shared media row once no other user references it, same as any
    // other library removal
    for (const track of catalog) {
        await deleteLibraryEntryForUser(userId, track.mediaId);
    }

    await recomputeAggregates(userId, -new Date().getTimezoneOffset());
}
