<template>
  <div class="library-home">
    <!-- DESIGN.md "Library": pinned elements (3 columns), the navigation buttons, then recently played (2 columns) -->
    <PinnedGrid />
    <div class="links">
      <NuxtLink to="/l/albums">{{ $t("sidebar.albums") }}</NuxtLink>
      <NuxtLink to="/l/tracks">{{ $t("sidebar.tracks") }}</NuxtLink>
      <NuxtLink to="/l/playlists">{{ $t("sidebar.playlists") }}</NuxtLink>
    </div>
    <h1 class="sp">{{ $t("library.recentlyPlayed") }}</h1>
    <RecentlyPlayed variant="grid" />
  </div>
</template>

<script lang="ts" setup>
import RecentlyPlayed from '~/components/RecentlyPlayed.vue';
import PinnedGrid from '~/components/PinnedGrid.vue';
</script>

<style>
.links {
  display: flex;
  flex-direction: column;
  gap: 1.5em;
  margin: 1em 0;
}

.links > a {
  position: relative;
  right: 0.5em;
  text-decoration: none;
  font-size: 1.6em;
  max-width: 100%;
}

.links > a::before {
  content: ">";
  font-family: "Instrument-Serif";
  color: color-mix(in srgb, currentColor 80%, transparent);
  position: relative;
  left: min(64vw, 900px);
  top: 0;
}

/* this element IS `.view` (app.vue): its margin clears the Header and the sidebar column, so only the size is set */
.library-home {
  max-width: 1200px;
  padding-top: 40px;
}

.sp {
  border-top: 1px solid #ffffffae;
}

@media screen and (max-width: 800px) {
  .links > a::before {
    left: calc(95vw - 1em);
  }
}
</style>
