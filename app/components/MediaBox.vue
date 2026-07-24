<template>
  <div class="mbox" :mb-id="media.id">
    <img :src="imgSrc" @error="imgSrc = noCover" draggable="false" loading="lazy" />
    <p class="title">{{ media.title }}</p>
    <p class="artist">{{ typeof media.artist == "string" ? media.artist : media.artist.name }}</p>
  </div>
</template>

<script lang="ts" setup>
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';
import noCover from '../assets/no-cover.png';

const props = defineProps<{ media: MediaInfo }>()

const imgSrc = ref(props.media.coverArt ?? noCover);
watch(() => props.media.coverArt, (coverArt) => imgSrc.value = coverArt ?? noCover);
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
</style>