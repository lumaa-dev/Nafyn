<template>
  <div class="mbox">
    <img :src="imgSrc" @error="imgSrc = noCover" draggable="false" loading="lazy" />
    <p class="title">{{ metadata.title }}</p>
    <p class="artist">{{ subtitle }}</p>
  </div>
</template>

<script lang="ts" setup>
import type { MetadataProviderId, SongMetadata } from '~~/server/utils/metadata/types';
import noCover from '../assets/no-cover.png';

const PROVIDER_NAMES: Record<MetadataProviderId, string> = {
  deezer: "Deezer",
  itunes: "iTunes",
  reccobeats: "ReccoBeats",
  discogs: "Discogs",
  theaudiodb: "TheAudioDB",
  genius: "Genius"
};

const props = defineProps<{ metadata: SongMetadata }>();

const imgSrc = ref(props.metadata.artwork[0] ?? noCover);
watch(() => props.metadata.artwork[0], (artwork) => imgSrc.value = artwork ?? noCover);

// same single secondary line as MediaBox's artist row - artists first, provider name folded in rather than
// a whole extra line, so the card keeps MediaBox's exact two-line layout and fixed height
const subtitle = computed(() => {
  const artists = props.metadata.artists.join(", ") || $t('common.unknownAlbum');
  return `${artists} · ${PROVIDER_NAMES[props.metadata.provider]}`;
});
</script>
