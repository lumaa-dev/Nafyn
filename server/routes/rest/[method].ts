// Subsonic API (http://www.subsonic.org/pages/api.jsp) compatibility layer, so any Subsonic-client app
// (Navidrome's own clients, Sound Room on iOS, DSub, Substreamer, ...) can browse and play a Nafyn library
// by pointing at this server instead of a real Subsonic/Navidrome instance.
//
// Not under server/api/ - Subsonic clients hardcode the path as `{server url}/rest/{method}[.view]`, with
// no `/api` prefix, so this has to live under server/routes/ to be served at the bare path (see server/routes/ws/downloads.ts).
//
// Scope: authentication, browsing (ID3 mode: artists/albums/songs), search, playlists (read + membership),
// cover art, and streaming/scrobbling - the parts that make "play my library through a Subsonic client" work.
// Not implemented: folder/index browsing (non-ID3), podcasts, radio stations, jukebox, shares, bookmarks,
// chat, starring/ratings, transcoding. See server/utils/subsonicAuth.ts for why token auth (t=/s=) isn't
// supported - only p= (plaintext or hex-encoded) password auth works against Nafyn's bcrypt-hashed accounts.
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { H3Event } from "h3";
import {
    findLibraryEntry,
    findAnyLibraryEntryForMedia,
    getAlbumOfUser,
    getAlbumSongsOfUser,
    getAlbumListOfUser,
    getArtistsOfUser,
    getArtistOfUser,
    getArtistAlbumsOfUser,
    getSongOfUser,
    searchLibraryOfUser,
    type AlbumListSort
} from "~~/server/core/library";
import { getPlaylistsForUser, getPlaylistById, getEntries, hasAccess } from "~~/server/core/playlists";
import { recordRecentlyPlayed } from "~~/server/core/recentlyPlayed";
import { playlistImageFilePath } from "~~/server/utils/playlistImage";
import { getLastfmArtistInfo } from "~~/server/utils/lastfm";
import { authenticateSubsonic } from "~~/server/utils/subsonicAuth";
import { sendSubsonicResponse, errorNode, SubsonicErrors, SubsonicApiError, el, type SubsonicNode, type SubsonicFormat } from "~~/server/utils/subsonicResponse";
import { songNode, albumNode, albumWithSongsNode, artistNode, artistWithAlbumsNode, playlistNode, playlistWithSongsNode, contentTypeFor } from "~~/server/utils/subsonicMapper";
import type { NafynUser } from "~~/server/entity/NafynUser";

function firstStr(query: Record<string, unknown>, key: string): string | undefined {
    const v = query[key];
    if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : undefined;
    return typeof v === "string" ? v : undefined;
}

function firstNum(query: Record<string, unknown>, key: string, fallback: number): number {
    const raw = firstStr(query, key);
    const n = raw !== undefined ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

function requireParam(query: Record<string, unknown>, key: string): string {
    const v = firstStr(query, key);
    if (!v) throw new SubsonicApiError(SubsonicErrors.missingParameter);
    return v;
}

type Handler = (event: H3Event, query: Record<string, unknown>, user: NafynUser) => Promise<SubsonicNode[]>;

const ALBUM_LIST_SORTS = new Set<AlbumListSort>(["newest", "alphabeticalByName", "alphabeticalByArtist", "random"]);

const handlers: Record<string, Handler> = {
    ping: async () => [],

    getLicense: async () => [el("license", { valid: true })],

    getMusicFolders: async () => [el("musicFolders", {}, [el("musicFolder", { id: 0, name: "Nafyn" })])],

    getArtists: async (_event, _query, user) => {
        const artists = await getArtistsOfUser(user.id);

        const groups = new Map<string, typeof artists>();
        for (const artist of artists) {
            const first = artist.name.charAt(0).toUpperCase();
            const letter = /[A-Z]/.test(first) ? first : "#";
            const group = groups.get(letter) ?? [];
            group.push(artist);
            groups.set(letter, group);
        }

        const indices = [...groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([letter, groupArtists]) => el("index", { name: letter }, groupArtists.map(artistNode)));

        return [el("artists", { ignoredArticles: "" }, indices)];
    },

    getArtist: async (_event, query, user) => {
        const id = requireParam(query, "id");
        const artist = await getArtistOfUser(user.id, id);
        if (!artist) throw new SubsonicApiError(SubsonicErrors.notFound);

        const albums = await getArtistAlbumsOfUser(user.id, id);
        return [artistWithAlbumsNode(artist, albums)];
    },

    // OpenSubsonic/Subsonic's dedicated bio+image endpoint, backed by Last.fm (see server/utils/lastfm.ts) -
    // getArtist above stays MusicBrainz/local-only since that's the one every client calls just to browse
    getArtistInfo2: async (_event, query, user) => {
        const id = requireParam(query, "id");
        const artist = await getArtistOfUser(user.id, id);
        if (!artist) throw new SubsonicApiError(SubsonicErrors.notFound);

        // getArtistsOfUser/getArtistOfUser fall back to the artist's display name as `id` when no
        // MusicBrainz artist credit is known (see server/core/library.ts) - only pass a real mbid to Last.fm
        const mbid = artist.id !== artist.name ? artist.id : undefined;
        const lastfm = await getLastfmArtistInfo(artist.name, mbid);

        return [el("artistInfo2", {
            biography: lastfm?.bio ?? undefined,
            smallImageUrl: lastfm?.image ?? undefined,
            mediumImageUrl: lastfm?.image ?? undefined,
            largeImageUrl: lastfm?.image ?? undefined
        })];
    },

    getAlbum: async (_event, query, user) => {
        const id = requireParam(query, "id");
        const album = await getAlbumOfUser(user.id, id);
        if (!album) throw new SubsonicApiError(SubsonicErrors.notFound);

        const songs = await getAlbumSongsOfUser(user.id, id);
        return [albumWithSongsNode(album, songs)];
    },

    getAlbumList2: async (_event, query, user) => {
        const rawType = firstStr(query, "type") ?? "newest";
        const sort: AlbumListSort = ALBUM_LIST_SORTS.has(rawType as AlbumListSort) ? (rawType as AlbumListSort) : "newest";
        const size = Math.min(Math.max(firstNum(query, "size", 50), 1), 500);
        const offset = Math.max(firstNum(query, "offset", 0), 0);

        const albums = await getAlbumListOfUser(user.id, sort, size, offset);
        return [el("albumList2", {}, albums.map(albumNode))];
    },

    getSong: async (_event, query, user) => {
        const id = requireParam(query, "id");
        const song = await getSongOfUser(user.id, id);
        if (!song) throw new SubsonicApiError(SubsonicErrors.notFound);
        return [songNode(song)];
    },

    search3: async (_event, query, user) => {
        const q = firstStr(query, "query")?.replace(/^"|"$/g, "") ?? "";
        const artistCount = Math.min(Math.max(firstNum(query, "artistCount", 20), 0), 200);
        const albumCount = Math.min(Math.max(firstNum(query, "albumCount", 20), 0), 200);
        const songCount = Math.min(Math.max(firstNum(query, "songCount", 20), 0), 200);

        const results = await searchLibraryOfUser(user.id, q, artistCount, albumCount, songCount);
        return [el("searchResult3", {}, [
            ...results.artists.map(artistNode),
            ...results.albums.map(albumNode),
            ...results.songs.map(songNode)
        ])];
    },

    getPlaylists: async (_event, _query, user) => {
        const playlists = await getPlaylistsForUser(user.id);
        const nodes = await Promise.all(playlists.map(async (playlist) => {
            const entries = await getEntries(playlist.id);
            const duration = entries.reduce((sum, e) => sum + e.media.duration, 0);
            return playlistNode(playlist, entries.length, duration);
        }));
        return [el("playlists", {}, nodes)];
    },

    getPlaylist: async (_event, query, user) => {
        const id = requireParam(query, "id");
        const playlist = await getPlaylistById(id);
        if (!playlist) throw new SubsonicApiError(SubsonicErrors.notFound);

        const isOwner = playlist.ownerId === user.id;
        if (playlist.privacy === "private" && !isOwner && !(await hasAccess(playlist, user.id))) {
            throw new SubsonicApiError(SubsonicErrors.notFound);
        }

        const entries = await getEntries(playlist.id);
        // playlist entries reference the shared media pool directly (server/core/playlists.ts), not this
        // viewer's own library_entries, so filePath for display comes from whichever owner has the file -
        // actual stream.view access is still gated per-viewer via findLibraryEntry, same as the rest of the app
        const filePathByMediaId = new Map<string, string>();
        for (const entry of entries) {
            const source = await findAnyLibraryEntryForMedia(entry.media.id);
            if (source) filePathByMediaId.set(entry.media.id, source.filePath);
        }

        return [playlistWithSongsNode(playlist, entries, filePathByMediaId)];
    },

    scrobble: async (_event, query, user) => {
        const id = requireParam(query, "id");
        const submission = firstStr(query, "submission");
        if (submission === undefined || submission === "true") {
            await recordRecentlyPlayed(user.id, "track", id);
        }
        return [];
    }
};

// stream/download/getCoverArt bypass the subsonic-response envelope entirely and write the raw
// bytes/headers straight onto the response, so they're dispatched separately from `handlers` above
async function handleStream(event: H3Event, query: Record<string, unknown>, user: NafynUser): Promise<void> {
    const id = requireParam(query, "id");
    const entry = await findLibraryEntry(user.id, id);
    if (!entry) throw new SubsonicApiError(SubsonicErrors.notFound);

    const stat = statSync(entry.filePath);
    const fileSize = stat.size;
    const mime = contentTypeFor(entry.filePath);

    setResponseHeader(event, "Accept-Ranges", "bytes");
    setResponseHeader(event, "Content-Type", mime);
    setResponseHeader(event, "Cache-Control", "private, max-age=3600");

    const range = getHeader(event, "Range");
    if (!range) {
        setResponseHeader(event, "Content-Length", fileSize);
        await sendStream(event, createReadStream(entry.filePath));
        return;
    }

    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (!match || (!match[1] && !match[2])) {
        throw createError({ statusCode: 416, statusMessage: "Invalid Range header" });
    }

    const start = match[1] ? parseInt(match[1], 10) : fileSize - parseInt(match[2]!, 10);
    const end = match[1] && match[2] ? parseInt(match[2], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
        setResponseHeader(event, "Content-Range", `bytes */${fileSize}`);
        throw createError({ statusCode: 416, statusMessage: "Range not satisfiable" });
    }

    setResponseStatus(event, 206);
    setResponseHeader(event, "Content-Range", `bytes ${start}-${end}/${fileSize}`);
    setResponseHeader(event, "Content-Length", end - start + 1);
    await sendStream(event, createReadStream(entry.filePath, { start, end }));
}

async function handleCoverArt(event: H3Event, query: Record<string, unknown>, user: NafynUser): Promise<void> {
    const id = requireParam(query, "id");
    const [prefix, ...rest] = id.split("-");
    const rawId = rest.join("-");

    let sourceUrl: string | null = null;
    let localFile: string | null = null;

    if (prefix === "mf") {
        const song = await getSongOfUser(user.id, rawId);
        sourceUrl = song?.coverArt ?? null;
    } else if (prefix === "al") {
        const album = await getAlbumOfUser(user.id, rawId);
        sourceUrl = album?.coverArt ?? null;
    } else if (prefix === "pl") {
        const path = playlistImageFilePath(rawId);
        if (existsSync(path)) localFile = path;
    }

    if (localFile) {
        setResponseHeader(event, "Content-Type", "image/webp");
        setResponseHeader(event, "Cache-Control", "private, max-age=3600");
        await sendStream(event, createReadStream(localFile));
        return;
    }

    if (!sourceUrl) throw new SubsonicApiError(SubsonicErrors.notFound);

    const upstream = await fetch(sourceUrl).catch(() => null);
    if (!upstream || !upstream.ok || !upstream.body) throw new SubsonicApiError(SubsonicErrors.notFound);

    setResponseHeader(event, "Content-Type", upstream.headers.get("Content-Type") ?? "image/jpeg");
    setResponseHeader(event, "Cache-Control", "public, max-age=86400");
    await sendStream(event, Readable.fromWeb(upstream.body as import("stream/web").ReadableStream));
}

const BINARY_METHODS = new Set(["stream", "download", "getCoverArt"]);

export default defineEventHandler(async (event) => {
    const raw = getRouterParam(event, "method") ?? "";
    const method = raw.replace(/\.view$/, "");

    const query: Record<string, unknown> = getQuery(event);
    // some Subsonic clients POST params as a form body instead of a query string
    if (event.method === "POST") {
        const contentType = getHeader(event, "Content-Type") ?? "";
        if (contentType.includes("form")) {
            try {
                Object.assign(query, await readBody(event));
            } catch {
                // no body, or not form-encoded - query params alone are fine
            }
        }
    }

    const formatParam = firstStr(query, "f");
    const format: SubsonicFormat = formatParam === "json" ? "json" : formatParam === "jsonp" ? "jsonp" : "xml";
    const callback = firstStr(query, "callback");

    try {
        const user = await authenticateSubsonic(event, query);

        if (BINARY_METHODS.has(method)) {
            if (method === "getCoverArt") await handleCoverArt(event, query, user);
            else await handleStream(event, query, user);
            return;
        }

        const handler = handlers[method];
        if (!handler) {
            return sendSubsonicResponse(event, format, "failed", [errorNode(SubsonicErrors.notFound)], callback);
        }

        const body = await handler(event, query, user);
        return sendSubsonicResponse(event, format, "ok", body, callback);
    } catch (e) {
        if (e instanceof SubsonicApiError) {
            return sendSubsonicResponse(event, format, "failed", [errorNode(e.err)], callback);
        }
        // an H3/Nuxt error (e.g. the 416 Range errors above) escaping a binary handler - let it propagate as-is
        throw e;
    }
});
