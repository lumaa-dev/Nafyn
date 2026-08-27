// the highlight reel manifest: everything the in-app story player needs to run, plus the status of the
// optional downloadable MP4.
import { getYearSnapshot } from "~~/server/core/insightsSnapshot";
import { getLibrariesDb } from "~~/server/core/db";
import { parseYear } from "~~/server/utils/insightsPeriod";
import type { MediaRow } from "~~/server/core/library";

const SLIDE_COUNT = 8;
const EXCERPT_SECONDS = 6;
const EXCERPT_START_RATIO = 0.3;

defineRouteMeta({
    openAPI: {
        description: "Highlight-reel manifest for one of the requesting user's years. Drives the in-app story player: ordered slides with headline statistics, cover art and an audio excerpt offset per top track. Also reports the status of the optional server-rendered MP4.",
        tags: ["insights"],
        operationId: "getHighlightReel",
        parameters: [
            { name: "year", in: "path", required: true, schema: { type: "integer" } }
        ],
        responses: {
            "200": { description: "", content: { "application/json": { schema: { $ref: "#/components/schemas/HighlightReel" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No year-end snapshot for that year yet", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        },
        $global: {
            components: {
                schemas: {
                    ReelSlide: {
                        type: "object",
                        required: ["kind"],
                        properties: {
                            kind: { type: "string", enum: ["intro", "stat", "track", "artist", "outro"] },
                            label: { type: "string", nullable: true, description: "i18n key for the slide's caption" },
                            value: { type: "string", nullable: true, description: "Pre-formatted headline number, where the slide has one" },
                            title: { type: "string", nullable: true },
                            subtitle: { type: "string", nullable: true },
                            cover: { type: "string", nullable: true },
                            trackId: { type: "string", nullable: true, description: "Stream this via /api/v1/library/{id}/stream for the slide's audio excerpt" },
                            excerptStartSeconds: { type: "integer", nullable: true },
                            excerptSeconds: { type: "integer", nullable: true }
                        }
                    },
                    HighlightReel: {
                        type: "object",
                        required: ["year", "slides", "collage", "reelStatus", "hasVideo"],
                        properties: {
                            year: { type: "integer" },
                            slides: { type: "array", items: { $ref: "#/components/schemas/ReelSlide" } },
                            collage: { type: "array", items: { type: "string" }, description: "Up to 9 cover-art URLs for the share card / collage" },
                            reelStatus: { type: "string", enum: ["none", "queued", "rendering", "ready", "failed"] },
                            reelError: { type: "string", nullable: true },
                            hasVideo: { type: "boolean", description: "True once the MP4 is downloadable from the `/asset` sub-route" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);
    const year = parseYear(getRouterParam(event, "year"));

    const snapshot = await getYearSnapshot(userId, year);
    if (!snapshot) {
        throw createError({ statusCode: 404, statusMessage: "No year-end summary for that year yet" });
    }

    const { totals, top } = snapshot.payload;
    const topTracks = top.track.slice(0, SLIDE_COUNT);

    // excerpt offsets need the real track length, and only for tracks the user still has - a slide for a
    // removed track would render but fail to play, so those are dropped
    const playable = new Map<string, MediaRow>();
    if (topTracks.length > 0) {
        const placeholders = topTracks.map(() => "?").join(", ");
        const rows = await getLibrariesDb().prepare(`
            SELECT m.* FROM media m
            JOIN library_entries le ON le.mediaId = m.id AND le.userId = ?
            WHERE m.id IN (${placeholders})
        `).all<MediaRow>(userId, ...topTracks.map((t) => t.entityId));
        for (const row of rows) playable.set(row.id, row);
    }

    const slides: Record<string, unknown>[] = [
        { kind: "intro", label: "insights.reel.intro", value: String(year) },
        { kind: "stat", label: "insights.reel.minutes", value: totals.totalMinutes.toLocaleString("en-US") },
        { kind: "stat", label: "insights.reel.uniqueTracks", value: String(totals.uniqueTracks) },
        { kind: "stat", label: "insights.reel.uniqueArtists", value: String(totals.uniqueArtists) },
        { kind: "stat", label: "insights.reel.streak", value: String(totals.longestStreakDays) }
    ];

    const topArtist = top.artist[0];
    if (topArtist) {
        slides.push({
            kind: "artist",
            label: "insights.reel.topArtist",
            title: topArtist.title,
            subtitle: `${topArtist.minutes}`,
            cover: topArtist.cover
        });
    }

    for (const track of topTracks) {
        const media = playable.get(track.entityId);
        if (!media) continue;

        slides.push({
            kind: "track",
            label: "insights.reel.topTrack",
            title: media.title,
            subtitle: media.artistName,
            cover: media.coverArt,
            trackId: media.id,
            // a third of the way in usually lands past the intro and inside the part people recognise
            excerptStartSeconds: Math.max(0, Math.floor(Number(media.duration) * EXCERPT_START_RATIO)),
            excerptSeconds: EXCERPT_SECONDS,
            value: String(track.playCount)
        });
    }

    slides.push({ kind: "outro", label: "insights.reel.outro", value: String(year) });

    return {
        year,
        slides,
        collage: top.track.map((t) => t.cover).filter((c): c is string => !!c).slice(0, 9),
        reelStatus: snapshot.reelStatus,
        reelError: snapshot.reelError,
        hasVideo: snapshot.hasReel
    };
});
