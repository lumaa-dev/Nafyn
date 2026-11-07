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
/* fills its grid cell up to 200px, so a two-column grid on a phone never overflows */
.mbox {
  width: 100%;
  max-width: 200px;
  min-width: 0;
  max-height: calc(230px + 2em);
}

.mbox img {
  width: 100%;
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
  color: var(--tint-fg, #ffffffae);
}
</style>