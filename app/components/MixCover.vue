<template>
  <!-- a mix has no cover of its own: four of its tracks' covers, or the first one alone when there are fewer -->
  <div class="mixcover" :class="{ single: tiles.length < 4 }" role="img" :aria-label="label">
    <CoverImage v-for="(src, i) in tiles" :key="i" :src="src" :eager="eager" />
  </div>
</template>

<script lang="ts" setup>
import { coverArtUrl, noCoverImage } from '~/composables/useCover';

const props = defineProps<{ covers: string[], label: string, eager?: boolean }>();

const tiles = computed(() => {
  const list = props.covers.slice(0, 4).map((c) => coverArtUrl(c));
  if (list.length >= 4) return list;
  return [list[0] ?? noCoverImage];
});
</script>

<style>
.mixcover {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 1 / 1;
  width: 100%;
  border-radius: 5px;
  overflow: hidden;
  background: #00000040;
}

.mixcover.single {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}

.mixcover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 0;
  aspect-ratio: auto;
}
</style>
