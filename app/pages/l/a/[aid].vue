<template>
  <div class="libalbum" v-if="detail">
    <div class="head">
      <img class="cover" :src="detail.album.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" />
      <div class="meta">
        <h1>{{ detail.album.title }}</h1>
        <p class="artist">{{ detail.album.artistName }}</p>
        <div class="actions">
          <button type="button" filled :disabled="tracks.length === 0" @click="playAll">{{ $t('playlist.play') }}</button>
          <button type="button" filled :disabled="tracks.length === 0" @click="shuffleAll">{{ $t('playlist.shuffle') }}</button>
        </div>
      </div>
    </div>

    <ol class="tracks" v-if="tracks.length > 0">
      <li v-for="track in tracks" :key="track.id" :class="{ playing: currentTrack?.id === track.id }" @click="playFrom(track)" @contextmenu.prevent="onContextMenu($event, track)">
        <img :src="track.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
        <span class="col">
          <span class="title">{{ track.title }}</span>
          <span class="artist">{{ track.artistName }}</span>
        </span>
        <span class="duration">{{ formatDuration(track.duration) }}</span>
        <button type="button" class="ellipsis" @click.stop="onEllipsis($event, track)" :aria-label="$t('playlist.addToPlaylist')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
      </li>
    </ol>

    <ContextMenu ref="trackMenu" :items="trackMenuItems" />
    <PlaylistPickerModal v-model="showPicker" :media-ids="pickerMediaIds" />
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow, AlbumRow } from '~~/server/core/library';
import noCover from '~/assets/no-cover.png';
import ContextMenu, { type ContextMenuItem } from '~/components/ContextMenu.vue';
import PlaylistPickerModal from '~/components/PlaylistPickerModal.vue';

const aid = useRoute().params.aid as string;
const token = useCookie("nafynToken").value;

interface LibraryAlbumDetail {
  album: AlbumRow;
  tracks: MediaRow[];
}

const { data: detail } = await useAsyncData<LibraryAlbumDetail>(`library-album-${aid}`, () => {
  return token
    ? $fetch(`/api/v1/library/album/${aid}`, { headers: { Authorization: token } })
    : Promise.reject(new Error("Not authenticated"));
});

const tracks = computed<MediaRow[]>(() => detail.value?.tracks ?? []);

const { currentTrack, play } = usePlayer();

function playAll() {
  if (tracks.value.length === 0) return;
  play(tracks.value[0]!, tracks.value, { type: "album", refId: aid });
}

function playFrom(track: MediaRow) {
  play(track, tracks.value, { type: "album", refId: aid });
}

function shuffleAll() {
  if (tracks.value.length === 0) return;
  const shuffled = [...tracks.value].sort(() => Math.random() - 0.5);
  play(shuffled[0]!, shuffled, { type: "album", refId: aid });
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

const showPicker = ref(false);
const pickerMediaIds = ref<string[]>([]);

const trackMenu = ref<InstanceType<typeof ContextMenu> | null>(null);
const trackMenuItems = ref<ContextMenuItem[]>([]);

function buildTrackMenu(track: MediaRow) {
  trackMenuItems.value = [{
    label: $t('track.viewDetails'),
    action: () => navigateTo(`/l/t/${track.id}`)
  }, {
    label: $t('playlist.addToPlaylist'),
    action: () => {
      pickerMediaIds.value = [track.id];
      showPicker.value = true;
    }
  }];
}

function onContextMenu(e: MouseEvent, track: MediaRow) {
  buildTrackMenu(track);
  trackMenu.value?.openAt(e.clientX, e.clientY);
}

function onEllipsis(e: MouseEvent, track: MediaRow) {
  buildTrackMenu(track);
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  trackMenu.value?.openAt(rect.left, rect.bottom);
}
</script>

<style scoped>
.libalbum {
  max-width: 900px;
  margin: calc(15vh - 10px) auto;
}

.libalbum .head {
  display: flex;
  flex-direction: row;
  gap: 30px;
  margin-bottom: 40px;
}

.libalbum .cover {
  width: 250px;
  height: 250px;
  aspect-ratio: 1 / 1;
  border-radius: 15px;
  background: #00000040;
}

.libalbum .meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.libalbum .meta .artist {
  font-family: "Instrument-Italic";
}

.libalbum .actions {
  display: flex;
  gap: 10px;
  margin-top: 1.2em;
}

.libalbum .tracks {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.libalbum .tracks li {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
  padding: 10px 0;
  cursor: pointer;
}

.libalbum .tracks li.playing .title {
  color: #ffffff;
  font-weight: 700;
}

.libalbum .tracks li:not(:last-child) {
  border-bottom: 1px solid #666666;
}

.libalbum .tracks img {
  width: 45px;
  height: 45px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
}

.libalbum .tracks .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.libalbum .tracks .title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.libalbum .tracks .artist {
  font-size: 0.85em;
  color: #666666;
}

.libalbum .tracks .duration {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: "Discy";
  font-size: 0.7em;
}

.libalbum .tracks .ellipsis {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: #666666;
  cursor: pointer;
  padding: 4px;
}

@media screen and (max-width: 800px) {
  .libalbum {
    margin: calc(15vh - 10px) 1.2em;
  }

  .libalbum .head {
    flex-direction: column;
  }

  .libalbum .cover {
    margin: 0 auto;
  }
}
</style>
