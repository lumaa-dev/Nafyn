// server-side rendering of the year-end highlight reel MP4.
//
// Two things carry the "audiovisual highlight reel" idea, and they are deliberately different artefacts:
//
//   * the in-app reel player (app/components/insights/ReelPlayer.vue) is the animated-statistics experience -
//     it plays in the browser, streams excerpts from the user's own library and needs no rendering at all,
//     so it is available the moment the snapshot exists;
//   * this module produces the *shareable file*: a montage of album art and short audio excerpts of the
//     year's top tracks, with the headline numbers burnt in, that a user can post somewhere Nafyn isn't.
//
// Rendering is opt-in per user per year because it is by far the most expensive thing this process does, and
// it runs strictly one at a time - a self-hosted Nafyn is usually sharing a CPU with everything else on the
// box, and a December stampede of parallel ffmpeg jobs would make the whole app unusable.
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { getLibrariesDb } from "./db";
import { getYearSnapshot, type ReelStatus } from "./insightsSnapshot";
import { assertUuid } from "~~/server/utils/ids";

if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
}

const REEL_DIR = join(process.cwd(), ".data", "reels");
const TMP_DIR = join(process.cwd(), ".data", "tmp");
const FONT_PATH = join(process.cwd(), "app", "assets", "fonts", "InstrumentSerif-Regular.ttf");
const NO_COVER_PATH = join(process.cwd(), "app", "assets", "no-cover.png");

const SLIDE_COUNT = 8;
const SLIDE_SECONDS = 6;
const VIDEO_SIZE = 720;
const EXCERPT_START_RATIO = 0.3;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const COVER_FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

// SECURITY: cover art URLs live in the `media` table, where they were written by the download pipeline from
// MusicBrainz metadata. Fetching them server-side is a request this process makes to a URL it did not
// author, which is the definition of an SSRF sink - so hosts are allowlisted, the scheme is forced to HTTPS,
// and redirects are followed by hand so every hop is re-checked rather than trusted.
const COVER_HOST_ALLOWLIST = ["coverartarchive.org", "archive.org"];

function isAllowedCoverUrl(url: URL): boolean {
    if (url.protocol !== "https:") return false;
    return COVER_HOST_ALLOWLIST.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/**
 * Where a user's reel for a year lives.
 *
 * The filename is built from a validated UUID and an integer, never from anything a caller typed, and the
 * result is re-checked against the directory prefix - the same belt-and-braces shape as
 * playlistImageFilePath, for the same reason.
 */
export function reelFilePath(userId: string, year: number): string {
    assertUuid(userId, "user ID");
    if (!Number.isInteger(year) || year < 1970 || year > 2037) {
        throw createError({ statusCode: 400, statusMessage: "Invalid year" });
    }

    const path = resolve(REEL_DIR, `${userId}-${year}.mp4`);
    if (!path.startsWith(resolve(REEL_DIR) + sep)) {
        throw createError({ statusCode: 400, statusMessage: "Invalid reel path" });
    }
    return path;
}

async function setReelStatus(userId: string, year: number, status: ReelStatus, extra: { path?: string | null, error?: string | null } = {}): Promise<void> {
    await getLibrariesDb().prepare(`
        UPDATE user_year_snapshots
        SET reel_status = :status,
            reel_path = IF(:setPath = 1, :path, reel_path),
            reel_error = :error
        WHERE user_id = :userId AND bucket_year = :year
    `).run({
        userId,
        year,
        status,
        setPath: extra.path !== undefined ? 1 : 0,
        path: extra.path ?? null,
        error: extra.error ?? null
    });
}

/** Queues a render. Returns the new status so the caller can tell "queued now" from "already running". */
export async function queueReel(userId: string, year: number): Promise<ReelStatus> {
    const snapshot = await getYearSnapshot(userId, year);
    if (!snapshot) {
        throw createError({ statusCode: 404, statusMessage: "No year-end snapshot to build a reel from yet" });
    }

    // re-queueing something already in flight would let a user pile up renders by clicking twice
    if (snapshot.reelStatus === "queued" || snapshot.reelStatus === "rendering") return snapshot.reelStatus;

    await setReelStatus(userId, year, "queued", { error: null });
    return "queued";
}

export async function getReelStatus(userId: string, year: number): Promise<ReelStatus> {
    const snapshot = await getYearSnapshot(userId, year);
    return snapshot?.reelStatus ?? "none";
}

// one render at a time, process-wide. ffmpeg will happily eat every core it is given.
let rendering = false;

/** Picks up one queued reel and renders it. Called every scheduler tick. */
export async function renderQueuedReels(): Promise<void> {
    if (rendering) return;

    const row = await getLibrariesDb().prepare(`
        SELECT user_id, bucket_year FROM user_year_snapshots
        WHERE reel_status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
    `).get<{ user_id: string, bucket_year: number }>();

    if (!row) return;

    rendering = true;
    try {
        await renderReel(row.user_id, Number(row.bucket_year));
    } catch (error) {
        // recorded on the row, never thrown: a failed render must not take the scheduler tick with it
        console.error(`[insights] reel render failed for ${row.user_id} ${row.bucket_year}:`, error);
        await setReelStatus(row.user_id, Number(row.bucket_year), "failed", {
            error: String((error as Error)?.message ?? error).slice(0, 1000)
        }).catch(() => {});
    } finally {
        rendering = false;
    }
}

interface SlideSource {
    rank: number,
    title: string,
    subtitle: string,
    coverUrl: string | null,
    audioPath: string | null,
    durationSeconds: number
}

/**
 * Resolves the top tracks of the snapshot to things ffmpeg can actually read: a local audio file the user
 * still owns, and a cover art URL.
 *
 * Tracks the user has since removed from their library are skipped rather than rendered silently - the reel
 * is built from files, and there is no file.
 */
async function collectSlides(userId: string, year: number): Promise<SlideSource[]> {
    const snapshot = await getYearSnapshot(userId, year);
    if (!snapshot) throw new Error("snapshot missing");

    const topTracks = snapshot.payload.top.track.slice(0, SLIDE_COUNT * 2);
    if (topTracks.length === 0) throw new Error("no tracks in snapshot");

    const placeholders = topTracks.map(() => "?").join(", ");
    const rows = await getLibrariesDb().prepare(`
        SELECT m.id, m.title, m.artistName, m.coverArt, m.duration, le.filePath
        FROM media m
        JOIN library_entries le ON le.mediaId = m.id AND le.userId = ?
        WHERE m.id IN (${placeholders})
    `).all<{ id: string, title: string, artistName: string, coverArt: string | null, duration: number, filePath: string }>(
        userId, ...topTracks.map((t) => t.entityId)
    );

    const byId = new Map(rows.map((r) => [r.id, r]));

    const slides: SlideSource[] = [];
    for (const track of topTracks) {
        const media = byId.get(track.entityId);
        if (!media) continue;

        slides.push({
            rank: track.rank,
            title: media.title,
            subtitle: media.artistName,
            coverUrl: media.coverArt,
            audioPath: media.filePath,
            durationSeconds: Number(media.duration) || 0
        });

        if (slides.length >= SLIDE_COUNT) break;
    }

    if (slides.length === 0) throw new Error("none of the year's top tracks are still in the library");
    return slides;
}

/** Fetches one cover image, validating every redirect hop against the allowlist. Returns null on any doubt. */
async function fetchCover(rawUrl: string, destDir: string): Promise<string | null> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isAllowedCoverUrl(url)) return null;

        let response: Response;
        try {
            response = await fetch(url, {
                redirect: "manual",
                signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS)
            });
        } catch {
            return null;
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) return null;
            // resolved against the current URL, then re-checked at the top of the next iteration - this is
            // the whole reason redirects aren't left to fetch()
            url = new URL(location, url);
            continue;
        }

        if (!response.ok) return null;

        const type = response.headers.get("content-type") ?? "";
        if (!type.startsWith("image/")) return null;

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0 || buffer.length > MAX_COVER_BYTES) return null;

        const path = join(destDir, `${randomUUID()}.img`);
        await writeFile(path, buffer);
        return path;
    }

    return null;
}

function runFfmpeg(configure: (command: ffmpeg.FfmpegCommand) => ffmpeg.FfmpegCommand, outputPath: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        configure(ffmpeg())
            .on("error", reject)
            .on("end", () => resolvePromise())
            .save(outputPath);
    });
}

// ffmpeg's drawtext takes its text inline in a filter string, where ':', '\' and quotes are syntax. Escaping
// is what stops a track title from rewriting the filtergraph.
function escapeDrawText(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\u2019")
        .replace(/:/g, "\\:")
        .replace(/%/g, "\\%")
        .slice(0, 60);
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

/** one slide: a still cover, a 6-second excerpt, and the rank/title/artist burnt in */
async function renderSlide(slide: SlideSource, imagePath: string, outputPath: string, hasFont: boolean): Promise<void> {
    const startSeconds = Math.max(0, Math.floor(slide.durationSeconds * EXCERPT_START_RATIO));

    // scale-and-crop to a square, dim the lower third so text stays readable over bright artwork
    const filters = [
        `scale=${VIDEO_SIZE}:${VIDEO_SIZE}:force_original_aspect_ratio=increase`,
        `crop=${VIDEO_SIZE}:${VIDEO_SIZE}`,
        `drawbox=y=${Math.round(VIDEO_SIZE * 0.68)}:w=${VIDEO_SIZE}:h=${Math.round(VIDEO_SIZE * 0.32)}:color=black@0.55:t=fill`
    ];

    if (hasFont) {
        const font = FONT_PATH.replace(/\\/g, "/").replace(/:/g, "\\:");
        filters.push(
            `drawtext=fontfile='${font}':text='#${slide.rank}':fontsize=44:fontcolor=0xe18c46:x=40:y=${Math.round(VIDEO_SIZE * 0.71)}`,
            `drawtext=fontfile='${font}':text='${escapeDrawText(slide.title)}':fontsize=40:fontcolor=white:x=40:y=${Math.round(VIDEO_SIZE * 0.78)}`,
            `drawtext=fontfile='${font}':text='${escapeDrawText(slide.subtitle)}':fontsize=28:fontcolor=0xbbbbbb:x=40:y=${Math.round(VIDEO_SIZE * 0.86)}`
        );
    }

    await runFfmpeg((command) => command
        .input(imagePath).inputOptions("-loop", "1")
        .input(slide.audioPath!).inputOptions("-ss", String(startSeconds))
        .outputOptions(
            "-t", String(SLIDE_SECONDS),
            "-vf", filters.join(","),
            "-r", "25",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "44100",
            "-ac", "2",
            // every slide must come out with identical stream parameters, or the concat demuxer refuses to
            // join them
            "-shortest"
        ), outputPath);
}

export async function renderReel(userId: string, year: number): Promise<string> {
    const outputPath = reelFilePath(userId, year);
    await setReelStatus(userId, year, "rendering", { error: null });

    const workDir = join(TMP_DIR, `reel-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
    await mkdir(REEL_DIR, { recursive: true });

    try {
        const slides = await collectSlides(userId, year);
        const hasFont = await fileExists(FONT_PATH);
        const hasFallbackCover = await fileExists(NO_COVER_PATH);

        const slidePaths: string[] = [];

        for (const [index, slide] of slides.entries()) {
            if (!slide.audioPath || !await fileExists(slide.audioPath)) continue;

            let imagePath = slide.coverUrl ? await fetchCover(slide.coverUrl, workDir) : null;
            if (!imagePath && hasFallbackCover) imagePath = NO_COVER_PATH;
            // no artwork and no fallback asset: skip rather than render a black square
            if (!imagePath) continue;

            const slidePath = join(workDir, `slide-${index}.mp4`);
            await renderSlide(slide, imagePath, slidePath, hasFont);
            slidePaths.push(slidePath);
        }

        if (slidePaths.length === 0) throw new Error("no slides could be rendered");

        // concat demuxer over a list file; paths are ours, but they still get single-quote-escaped because
        // the list format treats quotes as syntax
        const listPath = join(workDir, "slides.txt");
        await writeFile(listPath, slidePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

        await runFfmpeg((command) => command
            .input(listPath)
            .inputOptions("-f", "concat", "-safe", "0")
            // every slide was encoded with the same parameters above, so the streams copy straight through
            // and the join costs nothing
            .outputOptions("-c", "copy", "-movflags", "+faststart"), outputPath);

        await setReelStatus(userId, year, "ready", { path: `${userId}-${year}.mp4`, error: null });
        return outputPath;
    } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

/** removes a user's rendered reels from disk; called when they erase their history */
export async function deleteReelsForUser(userId: string, years: number[]): Promise<void> {
    for (const year of years) {
        await rm(reelFilePath(userId, year), { force: true }).catch(() => {});
    }
}
