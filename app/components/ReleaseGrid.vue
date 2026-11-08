<template>
  <section class="rgrid" :aria-labelledby="headingId">
    <h2 :id="headingId">{{ title }}</h2>
    <p v-if="description" class="rgrid-description">{{ description }}</p>
    <!-- horizontally scrollable inside its own frame: the page itself never scrolls sideways -->
    <div class="rgrid-scroll" role="list" tabindex="0" :aria-label="title">
      <slot />
    </div>
  </section>
</template>

<script lang="ts" setup>
// The "category grid" (DESIGN.md "Release categories"): a titled row of covers, scrolled sideways inside its own
// frame - 2 rows on wide screens of the web, 1 row on small screens and on iOS. Its children are the cards
// (`MediaBox` inside a link), each with `role="listitem"`-less plain markup: the grid is the list.
defineProps<{ title: string, description?: string | null }>();

const headingId = `rgrid-${useId()}`;
</script>

<style>
.rgrid {
  margin-bottom: 30px;
  min-width: 0;
}

.rgrid h2 {
  margin-bottom: 6px;
}

.rgrid .rgrid-description {
  margin: 0 0 14px;
  font-size: 0.85em;
  color: var(--tint-fg, #ffffffae);
}

/* reaches the edge of the content column, so covers scroll under the edge instead of stopping short of it */
.rgrid .rgrid-scroll {
  margin: 0 -1.2em;
  padding: 10px 1.2em;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: min(200px, 44vw);
  grid-template-rows: repeat(2, auto);
  align-items: start;
  gap: 20px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.rgrid .rgrid-scroll::-webkit-scrollbar {
  display: none;
}

.rgrid .rgrid-scroll > a,
.rgrid .rgrid-scroll > .rgrid-card {
  min-width: 0;
  font-family: "Instrument-Serif";
  text-decoration: none;
  border-radius: 8px;
  transition: opacity 0.2s ease-out;
}

.rgrid .rgrid-scroll > a:hover {
  opacity: 0.85;
}

/* the card being viewed (a release of the album the page is about): an outline, not just a colour */
.rgrid .rgrid-scroll > a[aria-current="true"] {
  outline: 2px solid currentColor;
  outline-offset: 4px;
}

.rgrid .rgrid-scroll:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}

/* small screens: one row */
@media screen and (max-width: 800px) {
  .rgrid .rgrid-scroll {
    grid-template-rows: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rgrid .rgrid-scroll > a {
    transition: none;
  }
}
</style>
