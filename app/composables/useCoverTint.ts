// DESIGN.md "Track/Album Detail view": a detail screen is coloured with the cover art's primary colour, and its
// labels are white or black, whichever contrasts (the server picks `textColor` against `imageColors[0]`).
//
// The colours go on <body> for as long as the page is mounted (useHead drops them on unmount, so the next page is
// back on the default background), through `--tint-fg` as well so hollow buttons follow the label colour.
interface Tinted {
    imageColors?: string[] | null,
    textColor?: string | null
}

function channel(value: number): number {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: number, b: number): number {
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function parseHex(hex: string): [number, number, number] | null {
    let value = hex.slice(1);
    if (value.length === 3 || value.length === 4) value = [...value].map((c) => c + c).join("");
    if (value.length !== 6 && value.length !== 8) return null;
    const n = parseInt(value.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const AAA = 7.1;

/**
 * DESIGN.md "Contrast" (WCAG AAA, 7:1): the label is white or black, whichever contrasts more with the cover's primary
 * colour - and when even that is short of 7:1 (every mid-tone is), the background is moved towards black (white label)
 * or white (black label) until it is. The hue stays the cover's own, only its lightness gives way.
 */
export function readableTint(background: string): { background: string, text: string } {
    const rgb = parseHex(background);
    if (!rgb) return { background, text: "#ffffff" };

    const lum = luminance(rgb);
    const text = contrast(lum, 1) >= contrast(lum, 0) ? "#ffffff" : "#000000";
    const target: [number, number, number] = text === "#ffffff" ? [0, 0, 0] : [255, 255, 255];
    const textLum = text === "#ffffff" ? 1 : 0;

    let mixed = rgb;
    for (let step = 0; step <= 20 && contrast(luminance(mixed), textLum) < AAA; step++) {
        const t = step / 20;
        mixed = [0, 1, 2].map((i) => Math.round(rgb[i]! + (target[i]! - rgb[i]!) * t)) as [number, number, number];
    }
    return { background: `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`, text };
}

export function useCoverTint(source: () => Tinted | null | undefined) {
    useHead({
        bodyAttrs: {
            style: computed(() => {
                const tint = source();
                const background = tint?.imageColors?.[0];
                if (!background || !/^#[0-9a-f]{3,8}$/i.test(background)) return "";
                const readable = readableTint(background);
                const dark = readable.text === "#000000";
                // --page-tint-*: a filled button is the label colour with the background as its label (>= 7:1 both
                // ways by construction), so it never fades into a light or dark cover. app.vue applies them inside
                // the page only (`.view`), never to a sheet teleported over it.
                return `background: ${readable.background}; color: ${readable.text}; --tint-fg: ${readable.text}; --icon-filter: ${dark ? "none" : "invert(1)"};`
                    + ` --page-tint-fill: ${readable.text}; --page-tint-label: ${readable.background}; --page-tint-fill-icon: ${dark ? "invert(1)" : "none"};`;
            })
        }
    });
}
