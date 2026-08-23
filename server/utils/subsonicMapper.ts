// maps Nafyn's own row shapes (server/core/library.ts, playlists.ts) onto Subsonic API "ID3" elements
// (artist/album/song) - see server/routes/rest/[method].ts for how these get assembled per endpoint
import { extname } from "node:path";
import type { AlbumRow, ArtistRow, SubsonicSong } from "./library";
import type { PlaylistRow, PlaylistEntryWithMedia } from "./playlists";
import { el, type SubsonicNode } from "./subsonicResponse";

const MIME_TYPES: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav"
};

export function contentTypeFor(filePath: string): string {
    return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function suffixFor(filePath: string): string {
    return extname(filePath).replace(/^\./, "") || "bin";
}

// prefixed so getCoverArt.view can tell which table an id came from without a second lookup
export const coverArtId = {
    song: (mediaId: string) => `mf-${mediaId}`,
    album: (albumId: string) => `al-${albumId}`,
    playlist: (playlistId: string) => `pl-${playlistId}`
};

function isoDate(msOrSec: number, isSeconds: boolean = false): string {
    return new Date(isSeconds ? msOrSec * 1000 : msOrSec).toISOString();
}

export function songNode(song: SubsonicSong): SubsonicNode {
    return el("song", {
        id: song.id,
        parent: song.albumId ?? undefined,
        isDir: false,
        title: song.title,
        album: song.album ?? undefined,
        artist: song.artistName,
        year: song.releaseDate ? new Date(song.releaseDate * 1000).getUTCFullYear() : undefined,
        coverArt: song.coverArt ? coverArtId.song(song.id) : undefined,
        size: song.fileSize ?? undefined,
        contentType: contentTypeFor(song.filePath),
        suffix: suffixFor(song.filePath),
        duration: song.duration,
        path: song.filePath,
        created: isoDate(song.addedAt),
        albumId: song.albumId ?? undefined,
        artistId: song.artistMbid ?? song.artistName,
        type: "music",
        isVideo: false
    });
}

export function albumNode(album: AlbumRow): SubsonicNode {
    return el("album", {
        id: album.id,
        name: album.title ?? "Unknown Album",
        artist: album.artistName,
        artistId: album.artistMbid ?? album.artistName,
        coverArt: album.coverArt ? coverArtId.album(album.id) : undefined,
        songCount: album.trackCount,
        duration: Math.round(album.duration),
        year: album.releaseDate ? new Date(album.releaseDate * 1000).getUTCFullYear() : undefined,
        created: album.releaseDate ? isoDate(album.releaseDate, true) : isoDate(Date.now())
    });
}

export function albumWithSongsNode(album: AlbumRow, songs: SubsonicSong[]): SubsonicNode {
    const node = albumNode(album);
    node.tag = "album";
    node.children = songs.map(songNode);
    return node;
}

export function artistNode(artist: ArtistRow): SubsonicNode {
    return el("artist", {
        id: artist.id,
        name: artist.name,
        albumCount: artist.albumCount
    });
}

export function artistWithAlbumsNode(artist: ArtistRow, albums: AlbumRow[]): SubsonicNode {
    const node = artistNode(artist);
    node.children = albums.map(albumNode);
    return node;
}

export function playlistNode(playlist: PlaylistRow, songCount: number, durationSeconds: number): SubsonicNode {
    return el("playlist", {
        id: playlist.id,
        name: playlist.title,
        comment: playlist.description ?? undefined,
        public: playlist.privacy === "public",
        songCount,
        duration: Math.round(durationSeconds),
        created: isoDate(playlist.createdAt),
        changed: isoDate(playlist.updatedAt),
        coverArt: playlist.image ? coverArtId.playlist(playlist.id) : undefined
    });
}

export function playlistWithSongsNode(playlist: PlaylistRow, entries: PlaylistEntryWithMedia[], filePathByMediaId: Map<string, string>): SubsonicNode {
    const durationSeconds = entries.reduce((sum, e) => sum + e.media.duration, 0);
    const node = playlistNode(playlist, entries.length, durationSeconds);
    node.children = entries
        .map((e) => {
            const filePath = filePathByMediaId.get(e.media.id);
            return filePath ? songNode({ ...e.media, filePath }) : null;
        })
        .filter((n): n is SubsonicNode => n !== null);
    return node;
}
