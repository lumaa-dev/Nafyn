<!-- mobile only -->

<template>
  <div class="library-home">
    <h1>{{ $t("library.recentlyPlayed") }}</h1>
    <RecentlyPlayed variant="grid" />
  </div>
</template>

<script lang="ts" setup>
import RecentlyPlayed from '~/components/RecentlyPlayed.vue';
</script>

<style>
.library-home {
  width: 70vw;
  max-width: 1200px;
  margin: calc(15vh - 10px) auto;
}

@media screen and (max-width: 800px) {
  .library-home {
    margin: calc(15vh - 10px) 1.2em;
    width: 90vw;
  }
}
</style>
