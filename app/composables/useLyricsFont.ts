// Lyrics font switch (Settings -> Appearance): the lyrics are set in Instrument Serif; turned on, they use the
// browser's default `sans-serif` instead (DESIGN.md "Lyrics Panel"). Per browser, in a cookie like
// useDyslexicFont, so the server renders the right font on the first paint.
export function useLyricsSansSerif() {
    return useCookie<boolean>("nafynLyricsSansSerif", {
        default: () => false,
        maxAge: 60 * 60 * 24 * 365,
        path: "/",
        sameSite: "lax"
    });
}
