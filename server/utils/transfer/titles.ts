// turning loosely-structured titles (YouTube videos, SoundCloud uploads, plain text lines) into artist + title

const VIDEO_NOISE = /\s*[([](?:official(?:\s+(?:music|lyrics?|hd|4k))?\s*(?:video|audio|visuali[sz]er|clip)?|(?:music|lyrics?)\s+video|lyrics?|audio|visuali[sz]er|video\s*(?:clip|oficial)|clip\s+officiel|hd|hq|4k|mv|m\/v)[)\]]/gi;

// "Daft Punk - One More Time (Official Video) [HD]" -> "Daft Punk - One More Time"
export function stripVideoNoise(title: string): string {
    return title
        .replace(VIDEO_NOISE, "")
        .replace(/\s*\|.*$/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// splits "Artist - Title" on the first spaced dash (hyphen, en or em dash); null when there isn't one
export function splitArtistTitle(value: string): { artist: string, title: string } | null {
    const match = /^(.+?)\s+[-–—]\s+(.+)$/.exec(value);
    if (!match) return null;
    const artist = match[1]!.trim();
    const title = match[2]!.trim();
    return artist && title ? { artist, title } : null;
}

// YouTube's auto-generated "Artist - Topic" channels carry a clean artist name; VEVO/"Official" channels mostly do
export function cleanChannelName(channel: string): string {
    return channel
        .replace(/\s+-\s+Topic$/i, "")
        .replace(/VEVO$/i, "")
        .replace(/\s+(?:official|officiel)$/i, "")
        .trim();
}
