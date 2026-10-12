<template>
  <article class="privacy">
    <!-- deliberately a div: Header.vue's style block is global, so a semantic header element here would
         pick up its fixed 15vh bar styling and sit on top of the real Header (see CLAUDE.md) -->
    <div class="intro">
      <h1>{{ doc?.title ?? $t('privacy.fallbackTitle') }}</h1>
      <p v-if="doc?.updated" class="updated">{{ $t('privacy.updated', { date: doc.updated }) }}</p>
    </div>

    <!-- operator identity comes from the environment, not the document: markdown is parsed at build time
         and can't interpolate runtime config (see content.config.ts) -->
    <section class="controller">
      <h2>{{ $t('privacy.controller.title') }}</h2>
      <p v-if="controller || contact">
        <span v-if="controller">{{ $t('privacy.controller.named', { name: controller }) }}</span>
        <span v-else>{{ $t('privacy.controller.unnamed') }}</span>
        <template v-if="contact"><br>{{ $t('privacy.controller.contact', { contact }) }}</template>
      </p>
      <p v-else>{{ $t('privacy.controller.missing') }}</p>
    </section>

    <ContentRenderer v-if="doc" :value="doc" class="prose" />
    <p v-else class="prose-missing">{{ $t('privacy.missing') }}</p>

    <div class="back">
      <NuxtLink to="/">{{ $t('privacy.back') }}</NuxtLink>
    </div>
  </article>
</template>

<script lang="ts" setup>
// GDPR art. 13/14: the information that has to be available *before* anyone hands over data, which is why
// this page is reachable without being logged in (exempted in app.vue's redirectIfLoggedOut, and linked
// from both login and register).
//
// The notice itself is long-form prose, so it lives in content/<locale>/privacy.md and goes through
// @nuxt/content rather than being assembled out of i18n keys - an operator amending it (which they may well
// have to: they are the data controller, and their deployment can process more than Nafyn itself does) gets
// a markdown file instead of a JSON string table. Only two things stay in code: the operator's identity,
// which is runtime config, and the handful of chrome strings below.
// only the fields this page touches - `body` is the parsed markdown AST ContentRenderer walks, the rest is
// frontmatter declared in content.config.ts
interface PrivacyDoc {
    title: string,
    description?: string,
    updated?: string,
    body: unknown
}

const { locale } = useI18n();

const config = useRuntimeConfig();
const controller = config.public.privacyController as string;
const contact = config.public.privacyContact as string;

// IMPORTANT: fetched from /api/v1/privacy rather than calling queryCollection() here. A client-side
// navigation into this page would run that query in the browser, against @nuxt/content's WASM SQLite build,
// which the app's CSP blocks (no `wasm-unsafe-eval`) - the page rendered but the notice never did. The
// route keeps the query server-side for both entry paths; see the comment in server/api/v1/privacy.get.ts.
//
// `locale` is a ref, so useFetch watches it and refetches when the language changes. The English document
// is the server's fallback when a locale has no translated file, so adding a language stays "drop in
// content/<code>/privacy.md".
const { data: doc } = await useFetch<PrivacyDoc | null>("/api/v1/privacy", {
    query: { locale }
});

useHead(() => ({ title: `Nafyn - ${doc.value?.title ?? "Privacy"}` }));
</script>

<style>
/* LAYOUT: `<NuxtPage class="view" />` in app.vue means this page's root element *is* `.view`, so its
   margins are what clear the fixed Header (15vh tall, 20vh below 800px) and the sidebar column. Overriding
   `margin` here - which `margin: 0 auto` did - puts the title straight under the Header and leaves the top
   of the notice hidden behind its black gradient. So: no margin override, only a max-width and the extra
   top padding that lands the first heading clear of the gradient's bottom edge rather than right at it. */
.privacy {
  max-width: 720px;
  padding: 40px 0 80px 0;
  line-height: 1.55;
}

.privacy .intro {
  margin-bottom: 32px;
}

.privacy .updated {
  color: #666666;
  font-family: "Instrument-Italic";
  font-size: 0.85em;
}

.privacy .controller {
  margin-bottom: 36px;
}

.privacy h2 {
  font-size: 1.1em;
  margin-bottom: 8px;
}

/* styles for the rendered markdown. Kept deliberately plain: the document controls its own structure, so
   this only has to make headings, lists and emphasis legible at the widths Nafyn actually renders at */
.privacy .prose h2 {
  margin-top: 36px;
}

.privacy .prose h3 {
  font-size: 0.98em;
  margin-top: 22px;
  margin-bottom: 4px;
}

.privacy .prose p,
.privacy .prose ul,
.privacy .prose ol {
  font-size: 0.92em;
}

.privacy .prose ul,
.privacy .prose ol {
  padding-left: 18px;
}

.privacy .prose li {
  margin-bottom: 4px;
}

/* retention lines are written as *emphasis* paragraphs in the markdown - a whole paragraph in <em> is the
   document saying "this is the aside", so it gets the muted treatment rather than italics mid-sentence */
.privacy .prose p > em:only-child {
  color: #666666;
  font-style: normal;
  font-size: 0.95em;
}

.privacy .prose-missing,
.privacy .back {
  margin-top: 48px;
  font-size: 0.9em;
}
</style>
