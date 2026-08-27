// renders a shareable PNG of a period's headline numbers, in the browser.
//
// Client-only: canvas does not exist during SSR, so every entry point guards on import.meta.client.
//
// Deliberately typography-and-colour only, with no album art. Cover images come from Cover Art Archive,
// which does not serve the CORS headers a canvas needs; drawing one would taint the canvas and make
// toBlob() throw a SecurityError at the very last step. A card that always works beats a prettier one that
// fails on most tracks.
export interface ShareCardSpec {
    /** e.g. "2026" or "August 2026" */
    period: string,
    heading: string,
    stats: { label: string, value: string }[],
    list: { rank: number, title: string, subtitle?: string | null }[],
    listHeading: string,
    footer: string
}

const WIDTH = 1080;
const HEIGHT = 1350;
const BG = "#2a2a27";
const ACCENT = "#e18c46";
const TEXT = "#ffffff";
const MUTED = "#8a8a86";

// "Instrument-Serif" is loaded as a webfont; if it hasn't finished loading the browser silently falls back,
// so the stack names a real serif rather than leaving it to chance
const SERIF = '"Instrument-Serif", Georgia, serif';
const MONO = '"Discy", ui-monospace, monospace';

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;

    let out = text;
    while (out.length > 1 && ctx.measureText(`${out}...`).width > maxWidth) {
        out = out.slice(0, -1);
    }
    return `${out}...`;
}

export async function renderShareCard(spec: ShareCardSpec): Promise<Blob | null> {
    if (!import.meta.client) return null;

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // waiting on the webfonts means the card looks like the app rather than like Times New Roman; a font
    // that never loads must not block the download, hence the catch
    if (document.fonts?.ready) await document.fonts.ready.catch(() => {});

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.fillStyle = ACCENT;
    ctx.fillRect(0, 0, WIDTH, 12);

    const margin = 90;
    let y = 190;

    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = ACCENT;
    ctx.font = `48px ${MONO}`;
    ctx.fillText(spec.period.toUpperCase(), margin, y);

    y += 90;
    ctx.fillStyle = TEXT;
    ctx.font = `82px ${SERIF}`;
    ctx.fillText(truncate(ctx, spec.heading, WIDTH - margin * 2), margin, y);

    // stats laid out two per row
    y += 80;
    const colWidth = (WIDTH - margin * 2) / 2;
    spec.stats.slice(0, 4).forEach((stat, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = margin + col * colWidth;
        const rowY = y + row * 150;

        ctx.fillStyle = MUTED;
        ctx.font = `30px ${MONO}`;
        ctx.fillText(truncate(ctx, stat.label.toUpperCase(), colWidth - 20), x, rowY + 40);

        ctx.fillStyle = TEXT;
        ctx.font = `72px ${MONO}`;
        ctx.fillText(truncate(ctx, stat.value, colWidth - 20), x, rowY + 110);
    });

    y += Math.ceil(Math.min(spec.stats.length, 4) / 2) * 150 + 60;

    ctx.fillStyle = ACCENT;
    ctx.font = `36px ${MONO}`;
    ctx.fillText(spec.listHeading.toUpperCase(), margin, y);
    y += 30;

    for (const item of spec.list.slice(0, 5)) {
        y += 88;

        ctx.fillStyle = MUTED;
        ctx.font = `44px ${MONO}`;
        ctx.fillText(String(item.rank).padStart(2, "0"), margin, y);

        ctx.fillStyle = TEXT;
        ctx.font = `50px ${SERIF}`;
        ctx.fillText(truncate(ctx, item.title, WIDTH - margin * 2 - 100), margin + 90, y);

        if (item.subtitle) {
            ctx.fillStyle = MUTED;
            ctx.font = `32px ${SERIF}`;
            ctx.fillText(truncate(ctx, item.subtitle, WIDTH - margin * 2 - 100), margin + 90, y + 42);
            y += 20;
        }
    }

    ctx.fillStyle = MUTED;
    ctx.font = `32px ${MONO}`;
    ctx.fillText(spec.footer, margin, HEIGHT - 80);

    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** renders the card and hands it to the browser as a download */
export async function downloadShareCard(spec: ShareCardSpec, filename: string): Promise<boolean> {
    const blob = await renderShareCard(spec);
    if (!blob) return false;

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();

    // revoking immediately can cancel the download in some browsers; a tick's grace is enough
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}
