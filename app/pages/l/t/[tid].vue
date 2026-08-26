<template>
  <div class="track" v-if="track">
    <div class="head">
      <img class="cover" :src="track.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" />
      <div class="meta">
        <span class="header">
          <h1>{{ track.title }}</h1>
        </span>
        <p class="artist">{{ track.artistName }}</p>
        <NuxtLink class="album-link" v-if="track.album && track.albumId" :to="`/l/a/${track.albumId}`">
          {{ track.album }}
        </NuxtLink>
        <div class="actions">
          <button type="button" filled @click="playTrack">{{ $t('playlist.play') }}</button>
          <button type="button" filled="hollow" @click="openPicker">{{ $t('playlist.addToPlaylist') }}</button>
        </div>
      </div>
    </div>

    <p class="details">
      <span v-if="track.duration > 0">{{ formatDuration(track.duration) }}</span>
      <span v-if="track.releaseDate"> &middot; {{ formatDate(track.releaseDate * 1000) }}</span>
      <span v-if="track.label"> &middot; ℗ {{ track.label }}</span>
      <span> &middot; <a :href="`https://musicbrainz.org/recording/${track.musicbrainzId}`">{{ $t('track.viewInMusicbrainz') }}</a></span>
    </p>

    <PlaylistPickerModal v-model="showPicker" :media-ids="track ? [track.id] : []" />
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import noCover from '~/assets/no-cover.png';
import PlaylistPickerModal from '~/components/PlaylistPickerModal.vue';

const { locale } = useI18n();
const tid = useRoute().params.tid as string;
const token = useCookie("nafynToken").value;

const { data: track } = await useAsyncData<MediaRow>(`library-track-${tid}`, () => {
  return token
    ? $fetch(`/api/v1/library/track/${tid}`, { headers: { Authorization: token } })
    : Promise.reject(new Error("Not authenticated"));
});

const { play } = usePlayer();

function playTrack() {
  if (!track.value) return;
  play(track.value, [track.value], { type: "track", refId: track.value.id });
}

const showPicker = ref(false);

function openPicker() {
  if (!track.value) return;
  showPicker.value = true;
}

function formatDate(date: string | number | Date): string {
  return new Date(date).toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric" });
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
</script>

<style scoped>
.track {
  max-width: 900px;
  margin: calc(15vh - 10px) auto;
}

.track .head {
  display: flex;
  flex-direction: row;
  gap: 30px;
  margin-bottom: 40px;
}

.track .head .header {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 20px;
}

.track .cover {
  width: 250px;
  height: 250px;
  aspect-ratio: 1 / 1;
  border-radius: 15px;
  background: #00000040;
}

.track .meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.track .artist {
  font-family: "Instrument-Italic";
}

.track .album-link {
  font-size: 0.85em;
  color: #666666;
  text-decoration: none;
  margin-top: 4px;
}

.track .album-link:hover {
  text-decoration: underline;
}

.track .actions {
  display: flex;
  gap: 10px;
  margin: 1.2em 0;
}

.track .details {
  font-size: 0.85em;
  color: #666666;
  margin: 1em 0;
}

@media screen and (max-width: 800px) {
  .track {
    margin: calc(15vh - 10px) 1.2em;
  }

  .track .head {
    flex-direction: column;
  }

  .track .head .header {
    flex-direction: column-reverse;
    align-items: start;
    gap: 0;
  }

  .track .head .cover {
    margin: 0 auto;
  }
}
</style>
