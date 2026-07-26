import { getMusicBrainzClient, parseReleaseDate } from "~~/server/utils/musicbrainz";
import { consumeRateLimit } from "~~/server/utils/rateLimit";
import type { MediaInfo } from "~~/server/entity/media/MediaInfo";
import type { ArtistInfo } from "~~/server/entity/media/ArtistInfo";

const MAX_ATTEMPTS = 30;
const WINDOW_MS = 60 * 1000;

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/i;

export default defineEventHandler(async (event) => {
    requireAuthToken(event);

    const isrc = getRouterParam(event, "isrc");
    if (!isrc || !ISRC_PATTERN.test(isrc)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid or missing ISRC" });
    }

    const client = getMusicBrainzClient();

    const result = await client.search("recording", { query: `isrc:${isrc}`, limit: 1 }).catch(() => {
        throw createError({ statusCode: 404, statusMessage: "No song found for ISRC " + isrc });
    });

    const match = result.recordings?.[0];
    if (!match) {
        throw createError({ statusCode: 404, statusMessage: "No song found for ISRC " + isrc });
    }

    const recording = await client.lookup("recording", match.id, ["artist-credits", "releases", "release-groups"]).catch(() => {
        throw createError({ statusCode: 404, statusMessage: "No song found for ISRC " + isrc });
    });

    const release = recording.releases?.[0];
    const albumMbid = release?.["release-group"]?.id ?? null;
    const credit = recording["artist-credit"]?.[0]?.artist;

    const artist: ArtistInfo | string = credit
        ? { name: credit.name, musicbrainzId: credit.id, description: null, image: null }
        : "Unknown Artist";

    const media: MediaInfo = {
        id: recording.id,
        title: recording.title,
        artist,
        album: release ? { id: albumMbid, type: null, title: release.title } : null,
        type: "track",
        coverArt: release?.id ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
        releaseDate: parseReleaseDate(recording["first-release-date"]),
        inLibrary: null,
        duration: recording.length ? Math.round(recording.length / 1000) : 0,
        label: null
    };

    return { ...media, albumMbid };
});
