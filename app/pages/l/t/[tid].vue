<template>
  <div class="track" v-if="track">
    <div class="head">
      <CoverImage class="cover" :src="coverSrc(track, 500)" eager />
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
          <!-- two text buttons plus Play overflowed the row on narrow screens; the secondary actions are symbols,
               named for assistive tech and on hover -->
          <button type="button" filled="hollow" class="icon-only" :title="$t('playlist.addToPlaylist')" :aria-label="$t('playlist.addToPlaylist')" @click="openPicker"><img src="~/assets/icons/plus.svg" alt="" draggable="false" /></button>
          <button type="button" filled="hollow" class="icon-only" :title="$t('edit.title')" :aria-label="$t('edit.title')" @click="showEdit = true"><img src="~/assets/icons/edit.svg" alt="" draggable="false" /></button>
          <button type="button" filled="hollow" class="icon-only" :title="$t('menu.more')" :aria-label="$t('menu.more')" @click="onMenu">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          </button>
        </div>
      </div>
    </div>

    <p class="details">
      <span v-if="appearance.showDuration && track.duration > 0">{{ formatDuration(track.duration) }}</span>
      <span v-if="appearance.showFileSize && track.fileSize != null"> &middot; {{ formatBytes(track.fileSize) }}</span>
      <span v-if="track.releaseDate"> &middot; {{ formatDate(track.releaseDate * 1000) }}</span>
      <span v-if="track.label"> &middot; ℗ {{ track.label }}</span>
      <span> &middot; <a :href="`https://musicbrainz.org/recording/${track.musicbrainzId}`">{{ $t('track.viewInMusicbrainz') }}</a></span>
    </p>

    <PlaylistPickerModal v-model="showPicker" :media-ids="track ? [track.id] : []" />
    <MediaEditModal v-model="showEdit" :media="track ?? null" @saved="onEdited" />
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import PlaylistPickerModal from '~/components/PlaylistPickerModal.vue';
import MediaEditModal from '~/components/MediaEditModal.vue';
import { useAppearanceSettings } from '~/composables/useAppearanceSettings';
import { useAuthToken } from '~/composables/useAuthToken';

const { locale } = useI18n();
const tid = useRoute().params.tid as string;
const { token } = useAuthToken();
const appearance = useAppearanceSettings();

const { data: track, error } = await useAsyncData<MediaRow>(`library-track-${tid}`, () => {
  return token.value
    ? $fetch(`/api/v1/library/track/${tid}`, { headers: { Authorization: token.value } })
    : Promise.reject(new Error("Not authenticated"));
});
useLoadErrorToast(error);

const { play } = useUnity();

function playTrack() {
  if (!track.value) return;
  play(track.value, [track.value], { type: "track", refId: track.value.id });
}

const showPicker = ref(false);
const showEdit = ref(false);

function onEdited(updated: MediaRow[]) {
  if (updated[0]) track.value = updated[0];
}

// the same menu as everywhere else (queue, pin, delete...); this is the details page, so no "View details"
const { openMenu } = useMediaMenu();
function onMenu(e: MouseEvent) {
  if (!track.value) return;
  void openMenu(e, { kind: "track", media: track.value }, {
    hideDetails: true,
    onChanged: (change) => {
      if (change.type === "deleted") void navigateTo("/l/tracks");
      else if (change.type === "edited" && change.media?.[0]) track.value = change.media[0];
    }
  });
}

function openPicker() {
  if (!track.value) return;
  showPicker.value = true;
}

function formatDate(date: string | number | Date): string {
  return new Date(date).toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric" });
}

</script>

<style scoped>
/* this element is `.view` (app.vue): its margin clears the Header and the sidebar, so only the size is set here */
.track {
  max-width: 900px;
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
  color: #ffffff;
  text-decoration: none;
  margin-top: 4px;
}

.track .album-link:hover {
  text-decoration: underline;
}

.track .actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 1.2em 0;
}

.track .details {
  font-size: 0.85em;
  color: #ffffff;
  margin: 1em 0;
}

@media screen and (max-width: 800px) {
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

  .track .actions {
    flex-wrap: wrap;
  }
}
</style>
