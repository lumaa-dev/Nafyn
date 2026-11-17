// Braccato themes for the lyrics panel (app/components/panels/LyricsPanel.vue). A Braccato theme is a stylesheet
// handed to the <braccato-lyrics> element: its `blyrics-*` comments configure the renderer, the rest is CSS it puts in
// the document head. Every rule is scoped under `.lyrics-panel`, so nothing here reaches the rest of the app.

/**
 * Always on - Nafyn's look, after DESIGN.md:
 * - "Contrast": the text is `--np-text`, the black or white the server picked against the cover's mesh gradient (set
 *   by now-playing.vue), never a fixed white. Lines not being sung, and the part of a line not sung yet, are a
 *   `color-mix()` of it kept high, not Braccato's default 30% white.
 * - "Now Playing": sizes for a panel at most half the screen wide rather than a full-screen view.
 * Braccato declares its colour variables on `:root`, where `--np-text` does not exist yet, so they are declared
 * again on the container, inside the surface.
 */
const NAFYN_THEME = `
/* blyrics-target-scroll-pos-ratio = 0.4; */

.lyrics-panel .blyrics-container {
  --blyrics-text-color: var(--np-text, #ffffff);
  --blyrics-ui-text-color: var(--np-text, #ffffff);
  --blyrics-lyric-active-color: var(--np-text, #ffffff);
  --blyrics-lyric-inactive-color: color-mix(in srgb, var(--np-text, #ffffff) 60%, transparent);
  --blyrics-glow-color: color-mix(in srgb, var(--np-text, #ffffff) 45%, transparent);
  --blyrics-translated-color: color-mix(in srgb, var(--np-text, #ffffff) 75%, transparent);
  --blyrics-credits-opacity: 0.75;
  --blyrics-credits-focused-opacity: 1;
  --blyrics-credits-font-size: 0.55em;
  --blyrics-font-size: 2rem;
  --blyrics-padding: 0.45rem;
  /* Braccato measures the room the first line needs and leaves the top padding to the host */
  padding-top: var(--blyrics-padding-top, 1rem);
}

@media screen and (max-width: 800px) {
  .lyrics-panel .blyrics-container {
    --blyrics-font-size: 1.6rem;
  }
}
`;

/**
 * On unless "sans-serif lyrics" is (Settings -> Appearance): the lyrics in Instrument Serif. With the setting on,
 * this theme is left out and Braccato's own font stack (`--blyrics-default-font-family`) applies.
 */
const INSTRUMENT_THEME = `
.lyrics-panel .blyrics-container {
  --blyrics-font-family: "Instrument-Serif", serif;
  --blyrics-font-weight: 600;
}
`;

export function lyricsTheme(options: { sansSerif: boolean }): string {
  return options.sansSerif ? NAFYN_THEME : NAFYN_THEME + INSTRUMENT_THEME;
}
