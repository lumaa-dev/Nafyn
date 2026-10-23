<template>
  <div class="abox" :mb-id="artist.musicbrainzId">
    <CoverImage :src="artist.image" />
    <p class="title">{{ artist.name }}</p>
    <p class="description">{{ artist.description }}</p>
  </div>
</template>

<script lang="ts" setup>
import type { ArtistInfo } from '~~/server/entity/media/ArtistInfo';

defineProps<{ artist: ArtistInfo }>()
</script>

<style>
.abox {
  width: 200px;
  max-height: calc(230px + 2em);
}

.abox img {
  width: 200px;
  border-radius: 10000px;
  aspect-ratio: 1 / 1;
  background: #00000040;
}

.abox > p {
  height: calc(1em + 10px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}

.abox .title {
  font-weight: 700;
}

.abox .description {
  color: #666666;
}
</style>