// DESIGN.md "Track/Album Detail view": a detail screen is coloured with the cover art's primary colour, and its
// labels are white or black, whichever contrasts (the server picks `textColor` against `imageColors[0]`).
//
// The colours go on <body> for as long as the page is mounted (useHead drops them on unmount, so the next page is
// back on the default background), through `--tint-fg` as well so hollow buttons follow the label colour.
interface Tinted {
    imageColors?: string[] | null,
    textColor?: string | null
}

export function useCoverTint(source: () => Tinted | null | undefined) {
    useHead({
        bodyAttrs: {
            style: computed(() => {
                const tint = source();
                const background = tint?.imageColors?.[0];
                if (!background || !/^#[0-9a-f]{3,8}$/i.test(background)) return "";
                const text = tint?.textColor === "#000000" ? "#000000" : "#ffffff";
                return `background: ${background}; color: ${text}; --tint-fg: ${text};`;
            })
        }
    });
}
