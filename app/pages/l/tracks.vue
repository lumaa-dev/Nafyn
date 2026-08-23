<template>
  <div class="libtracks">
    <h1>{{ $t('library.tracks.title') }}</h1>
    <ol class="tracks" v-if="tracks.length > 0">
      <li v-for="track in tracks" :key="track.id" :class="{ playing: currentTrack?.id === track.id }" @click="play(track, tracks, { type: 'track', refId: track.id })" @contextmenu.prevent="onContextMenu($event, track)">
        <img :src="track.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
        <span class="col">
          <span class="title">{{ track.title }}</span>
          <span class="artist">{{ track.artistName }}</span>
        </span>
        <NuxtLink v-if="track.album" :to="`/a/${track.albumId}`" class="album" @click.stop>{{ track.album }}</NuxtLink>
        <span class="duration">{{ formatDuration(track.duration) }}</span>
        <button type="button" class="ellipsis" @click.stop="onEllipsis($event, track)" :aria-label="$t('playlist.addToPlaylist')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
      </li>
    </ol>
    <p class="empty" v-else-if="!initialLoading">{{ $t('library.tracks.empty') }}</p>
    <div ref="sentinel" class="scroll-sentinel" />
    <p class="loading-more" v-if="loadingMore">{{ $t('common.loadingMore') }}</p>

    <ContextMenu ref="trackMenu" :items="trackMenuItems" />
    <PlaylistPickerModal v-model="showPicker" :media-ids="pickerMediaIds" />
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import noCover from '~/assets/no-cover.png';
import ContextMenu, { type ContextMenuItem } from '~/components/ContextMenu.vue';
import PlaylistPickerModal from '~/components/PlaylistPickerModal.vue';

const token = useCookie("nafynToken").value;

const { items: tracks, initialLoading, loadingMore, sentinel, loadMore, reset } = useInfiniteList<MediaRow>((page, limit) => {
  return token
    ? $fetch("/api/v1/library/tracks", { headers: { Authorization: token }, query: { page, limit } })
    : Promise.resolve({ items: [], page, limit, total: 0, hasMore: false });
});
await loadMore();

const { currentTrack, play } = usePlayer();
const { errorToast, sendToast } = useToast();

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
    label: $t('playlist.addToPlaylist'),
    action: () => {
      pickerMediaIds.value = [track.id];
      showPicker.value = true;
    }
  }, {
    label: $t("track.delete"),
    danger: true,
    action: () => deleteTrack(track)
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

async function deleteTrack(track: MediaRow) {
  if (!token) return;

  var hasError: string | null = null
  const result = await $fetch(`/api/v1/library/${track.id}`, {
    headers: { Authorization: token },
    method: "DELETE",
  }).catch(r => hasError = r)

  if (!result || hasError) { return sendToast(errorToast("Track", "Failed to delete")) }

  return reset();
}
</script>

<style>
.libtracks {
  width: 70vw;
  max-width: 1200px;
  margin: calc(15vh - 10px) auto;
}

.libtracks .empty {
  color: #666666;
}

.libtracks .scroll-sentinel {
  height: 1px;
}

.libtracks .loading-more {
  text-align: center;
  color: #666666;
  font-size: 0.8em;
  padding: 10px 0;
}

.libtracks .tracks {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.libtracks .tracks li {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
  padding: 10px 0;
  cursor: pointer;
}

.libtracks .tracks li.playing .title {
  color: #ffffff;
  font-weight: 700;
}

.libtracks .tracks li:not(:last-child) {
  border-bottom: 1px solid #666666;
}

.libtracks .tracks img {
  width: 45px;
  height: 45px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
}

.libtracks .tracks .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.libtracks .tracks .title, .libtracks .tracks .album {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.libtracks .tracks .artist {
  font-size: 0.85em;
  color: #666666;
}

.libtracks .tracks .album {
  max-width: 200px;
  font-size: 0.85em;
  color: #666666;
}

.libtracks .tracks .duration {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: "Discy";
  font-size: 0.7em;
}

.libtracks .tracks .ellipsis {
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
  .libtracks {
    margin: calc(15vh - 10px) auto;
    width: 90vw;
  }

  .libtracks .tracks .album {
    display: none;
  }

  .libtracks .tracks li {
    margin: 0 -1.2em;
    padding: 10px 1.2em;
  }
}
</style>
