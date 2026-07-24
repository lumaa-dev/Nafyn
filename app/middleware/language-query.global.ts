// lets ?l=fr / ?l=en override the detected language; unknown/malformed values (e.g. ?l=fr_FR) are silently ignored, keeping whatever locale was already active
export default defineNuxtRouteMiddleware(async (to) => {
    const lang = to.query.l;
    if (typeof lang !== "string") return;

    // useI18n() requires a component setup context, which route middleware doesn't have; useNuxtApp().$i18n works anywhere
    const { $i18n } = useNuxtApp();
    const availableCodes = $i18n.locales.value.map(l => typeof l === "string" ? l : l.code);

    if (!availableCodes.includes(lang) || lang === $i18n.locale.value) return;

    await $i18n.setLocale(lang);
});
