<template>
  <div class="library-home">
    <div class="links">
      <NuxtLink to="/l/playlists">{{ $t("sidebar.playlists") }}</NuxtLink>
      <NuxtLink to="/l/albums">{{ $t("sidebar.albums") }}</NuxtLink>
      <NuxtLink to="/l/tracks">{{ $t("sidebar.tracks") }}</NuxtLink>
    </div>
    <h1>{{ $t("library.recentlyPlayed") }}</h1>
    <RecentlyPlayed variant="grid" />
  </div>
</template>

<script lang="ts" setup>
import RecentlyPlayed from '~/components/RecentlyPlayed.vue';
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
  color: #666666;
  position: relative;
  left: calc(95vw - 1em);
  top: 0;
}

.library-home {
  width: 70vw;
  max-width: 1200px;
  margin: calc(20vh - 10px) auto;
}

@media screen and (max-width: 800px) {
  .library-home {
    width: 90vw;
  }
}
</style>
