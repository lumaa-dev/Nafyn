import { defineCollection, defineContentConfig, z } from "@nuxt/content";

// @nuxt/content was in the dependency list but had no collections and no content/ directory, so every boot
// logged "No content configuration found". It now has exactly one job: the privacy notice (GDPR art. 13),
// which is long-form prose that has no business being a wall of i18n string keys.
//
// One collection, one document per locale, path derived from the directory: content/en/privacy.md is
// /en/privacy. app/pages/privacy.vue picks the file matching the active locale and falls back to English
// when a locale has no translation, so adding a language is "drop in content/<code>/privacy.md".
//
// Note what does NOT live in the markdown: who the data controller is and how to reach them. Those come
// from NAFYN_PRIVACY_CONTROLLER / NAFYN_PRIVACY_CONTACT at runtime and are rendered by the page around the
// document - markdown is parsed at build time and cannot interpolate an operator's environment.
export default defineContentConfig({
    collections: {
        legal: defineCollection({
            type: "page",
            source: "**/privacy.md",
            schema: z.object({
                // shown as the page's <h1> and document title, so it is required rather than optional -
                // a notice that renders without a heading is a broken notice
                title: z.string(),
                description: z.string().optional(),
                // free-text, displayed as-is. Operators who amend the notice should bump it
                updated: z.string().optional()
            })
        })
    }
});
