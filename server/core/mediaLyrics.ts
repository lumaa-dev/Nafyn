// user-supplied lyrics for a media row.
//
// Nafyn already fetches lyrics from Cider/LRCLIB at read time (GET /api/v1/library/{id}/lyrics). This table
// is the manual override: whatever a user typed or pasted in for a track wins over every provider, and is
// the only lyric source a manually imported track (which no provider knows about) ever has.
//
// Content is stored verbatim as the user entered it, either as plain text or as an LRC-timed transcript;
// Nafyn does not author or fetch it here.
import { getLibrariesDb } from "./db";

export type LyricsFormat = "plain" | "lrc";

export interface MediaLyricsRow {
    mediaId: string,
    format: LyricsFormat,
    content: string,
    updatedAt: number
}

/** Longest lyric body accepted, in characters - well past any real song, short of a DoS-by-MEDIUMTEXT. */
export const MAX_LYRICS_LENGTH = 40000;

export async function getMediaLyrics(mediaId: string): Promise<MediaLyricsRow | null> {
    const row = await getLibrariesDb()
        .prepare(`SELECT * FROM media_lyrics WHERE mediaId = ?`)
        .get(mediaId) as MediaLyricsRow | undefined;
    return row ?? null;
}

export async function setMediaLyrics(mediaId: string, format: LyricsFormat, content: string): Promise<MediaLyricsRow> {
    const row: MediaLyricsRow = { mediaId, format, content, updatedAt: Date.now() };

    await getLibrariesDb().prepare(`
        INSERT INTO media_lyrics (mediaId, format, content, updatedAt)
        VALUES (:mediaId, :format, :content, :updatedAt)
        ON DUPLICATE KEY UPDATE format = :format, content = :content, updatedAt = :updatedAt
    `).run(row);

    return row;
}

export async function deleteMediaLyrics(mediaId: string): Promise<void> {
    await getLibrariesDb().prepare(`DELETE FROM media_lyrics WHERE mediaId = ?`).run(mediaId);
}
