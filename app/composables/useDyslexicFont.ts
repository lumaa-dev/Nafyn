// OpenDyslexic switch (Settings -> Appearance). Web-only and per browser: it lives in a cookie, never in
// the API, so the server can render <html class="dyslexic-font"> on the first paint instead of flashing the
// normal fonts until a client plugin catches up (a localStorage value would only exist after hydration).
//
// The CSS that does the replacing is in app/app.vue; app.vue calls applyDyslexicFont() once.
export const DYSLEXIC_FONT_CLASS = "dyslexic-font";

export function useDyslexicFont() {
    const enabled = useCookie<boolean>("nafynDyslexicFont", {
        default: () => false,
        maxAge: 60 * 60 * 24 * 365,
        path: "/",
        sameSite: "lax"
    });

    return enabled;
}

export function applyDyslexicFont() {
    const enabled = useDyslexicFont();

    useHead({
        htmlAttrs: {
            class: computed(() => enabled.value === true ? DYSLEXIC_FONT_CLASS : "")
        }
    });
}
