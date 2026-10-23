<template>
  <div class="mbox" :mb-id="media.id">
    <CoverImage :src="media.coverArt" />
    <p class="title">{{ media.title }}</p>
    <p class="artist">{{ typeof media.artist == "string" ? media.artist : media.artist.name }}</p>
  </div>
</template>

<script lang="ts" setup>
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';

defineProps<{ media: MediaInfo }>()
</script>

<style>
.mbox {
  width: 200px;
  max-height: calc(230px + 2em);
}

.mbox img {
  width: 200px;
  border-radius: 5px;
  aspect-ratio: 1 / 1;
  background: #00000040;
}

.mbox > p {
  height: calc(1em + 10px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}

.mbox .title {
  font-weight: 700;
}

.mbox .artist {
  font-size: 0.85em;
  color: #666666;
}
</style>