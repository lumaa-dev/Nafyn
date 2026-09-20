// dominant-color extraction for cover art, used to drive the NowPlaying background gradient and to pick
// a WCAG-compliant text color against the artwork's main color
import { readFile, stat } from "node:fs/promises";
import sharp from "sharp";
import { isAllowedCoverArtUrl } from "./coverArt";
import { mediaCoverFilePath } from "./mediaCover";

export interface ImageColorsResult {
    imageColors: string[],
    textColor: string
}

export interface CoverSource {
    coverArtUrl?: string | null,
    // a Nafyn media ID whose uploaded cover (mediaCoverFilePath) should be preferred over `coverArtUrl`,
    // mirroring the hasCustomCover precedence in handleCoverArt (server/routes/rest/[method].ts)
    customCoverMediaId?: string | null
}

const DEFAULT_RESULT: ImageColorsResult = { imageColors: [], textColor: "#ffffff" };
const DOMINANT_COLOR_COUNT = 5;
const QUANT_STEP = 32;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map<string, { value: ImageColorsResult, expiresAtMs: number }>();

function hexToRgb(hex: string): { r: number, g: number, b: number } {
    const clean = hex.replace("#", "");
    return {
        r: parseInt(clean.substring(0, 2), 16),
        g: parseInt(clean.substring(2, 4), 16),
        b: parseInt(clean.substring(4, 6), 16)
    };
}

function toHex(n: number): string {
    return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function relativeLuminance(r: number, g: number, b: number): number {
    const channels = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(luminanceA: number, luminanceB: number): number {
    const lighter = Math.max(luminanceA, luminanceB);
    const darker = Math.min(luminanceA, luminanceB);
    return (lighter + 0.05) / (darker + 0.05);
}

// picks whichever of pure black/white has the higher contrast ratio against `hex` - since every WCAG 2.x
// text-contrast level (AA, AA-large, AAA) is just a higher required ratio, maximizing the ratio satisfies
// as many of them as the color allows
export function pickTextColor(hex: string): string {
    const { r, g, b } = hexToRgb(hex);
    const luminance = relativeLuminance(r, g, b);
    const contrastWithBlack = contrastRatio(luminance, 0);
    const contrastWithWhite = contrastRatio(luminance, 1);
    return contrastWithBlack >= contrastWithWhite ? "#000000" : "#ffffff";
}

// quantizes pixels to a coarse per-channel grid and buckets them - a cheap stand-in for a full
// k-means/median-cut that's good enough for a handful of background-gradient swatches
async function extractDominantColors(buffer: Buffer, count: number): Promise<string[]> {
    const { data, info } = await sharp(buffer)
        .resize(64, 64, { fit: "inside" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const buckets = new Map<number, { r: number, g: number, b: number, count: number }>();
    const channels = info.channels;
    for (let i = 0; i + channels <= data.length; i += channels) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const key = (Math.floor(r / QUANT_STEP) << 16) | (Math.floor(g / QUANT_STEP) << 8) | Math.floor(b / QUANT_STEP);
        const bucket = buckets.get(key);
        if (bucket) {
            bucket.r += r;
            bucket.g += g;
            bucket.b += b;
            bucket.count++;
        } else {
            buckets.set(key, { r, g, b, count: 1 });
        }
    }

    return [...buckets.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, count)
        .map((bucket) => `#${toHex(bucket.r / bucket.count)}${toHex(bucket.g / bucket.count)}${toHex(bucket.b / bucket.count)}`);
}

async function loadRemoteCover(url: string): Promise<Buffer | null> {
    if (!isAllowedCoverArtUrl(url)) return null;
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
    } catch {
        return null;
    }
}

// resolves a cover source (local custom upload wins, else an allowlisted remote URL) into dominant
// swatch colors + a WCAG-picked text color; caches by content (file mtime for local covers, URL for
// remote ones) so the same artwork isn't re-fetched/re-quantized on every request
export async function getImageColors(source: CoverSource): Promise<ImageColorsResult> {
    let cacheKey: string | null = null;
    let buffer: Buffer | null = null;

    if (source.customCoverMediaId) {
        try {
            const path = mediaCoverFilePath(source.customCoverMediaId);
            const stats = await stat(path);
            cacheKey = `local:${source.customCoverMediaId}:${stats.mtimeMs}`;
            const cached = cache.get(cacheKey);
            if (cached && cached.expiresAtMs > Date.now()) return cached.value;
            buffer = await readFile(path);
        } catch {
            buffer = null;
        }
    }

    if (!buffer && source.coverArtUrl) {
        cacheKey = `url:${source.coverArtUrl}`;
        const cached = cache.get(cacheKey);
        if (cached && cached.expiresAtMs > Date.now()) return cached.value;
        buffer = await loadRemoteCover(source.coverArtUrl);
    }

    if (!buffer) return DEFAULT_RESULT;

    let value: ImageColorsResult;
    try {
        const imageColors = await extractDominantColors(buffer, DOMINANT_COLOR_COUNT);
        const textColor = imageColors[0] ? pickTextColor(imageColors[0]) : DEFAULT_RESULT.textColor;
        value = { imageColors, textColor };
    } catch {
        value = DEFAULT_RESULT;
    }

    if (cacheKey) cache.set(cacheKey, { value, expiresAtMs: Date.now() + CACHE_TTL_MS });
    return value;
}
