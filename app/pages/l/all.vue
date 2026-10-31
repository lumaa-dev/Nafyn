<template>
  <div class="libtracks bulk-page">
    <h1>{{ $t('library.all.title') }}</h1>
    <ol class="tracks" v-if="tracks.length > 0">
      <li
        v-for="track in tracks"
        :key="track.id"
        :class="{ 'selectable-row': selecting, selected: isSelected(track.id) }"
        @click="selecting ? toggle(track.id) : undefined"
        @contextmenu.prevent="onContextMenu($event, track)"
      >
        <input v-if="selecting" type="checkbox" class="select-box" :checked="isSelected(track.id)" :aria-label="track.title" tabindex="-1" @click.stop="toggle(track.id)">
        <CoverImage :src="coverSrc(track)" />
        <span class="col">
          <span class="title">{{ track.title }}</span>
          <span class="artist">{{ track.artistName }}</span>
        </span>
        <span class="owners">{{ track.owners.map(o => o.username).join(', ') }}</span>
        <NuxtLink v-if="track.album" :to="`/a/${track.albumId}`" class="album" @click.stop>{{ track.album }}</NuxtLink>
        <span class="filesize" v-if="appearance.showFileSize">{{ track.fileSize != null ? formatBytes(track.fileSize) : '—' }}</span>
        <span class="duration" v-if="appearance.showDuration">{{ formatDuration(track.duration) }}</span>
        <button v-if="!selecting" type="button" class="ellipsis" @click.stop="onContextMenu($event, track)" :aria-label="$t('menu.more')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
      </li>
    </ol>
    <p class="empty" v-else-if="!initialLoading">{{ $t('library.all.empty') }}</p>
    <div ref="sentinel" class="scroll-sentinel" />
    <p class="loading-more" v-if="loadingMore">{{ $t('common.loadingMore') }}</p>

    <BulkBar :selecting="selecting" :count="count" :total="tracks.length" @start="start" @stop="stop" @select-all="toggleAll" @actions="onBulkActions" />
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import type { MenuChange } from '~/composables/useMediaMenu';
import { useAppearanceSettings } from '~/composables/useAppearanceSettings';
import { useAuthToken } from '~/composables/useAuthToken';

type AllMediaRow = MediaRow & { owners: { userId: string; username: string }[] };

const { token } = useAuthToken();
const appearance = useAppearanceSettings();
const { user: me, ensureLoaded } = useCurrentUser();
await ensureLoaded();

const { items: tracks, initialLoading, loadingMore, sentinel, loadMore, reset } = useInfiniteList<AllMediaRow>((page, limit) => {
  return token.value
    ? $fetch("/api/v1/library/all", { headers: { Authorization: token.value }, query: { page, limit } })
    : Promise.resolve({ items: [], page, limit, total: 0, hasMore: false });
});
await loadMore();

const { openMenu, openBulkMenu } = useMediaMenu();
const { selecting, selectedIds, count, isSelected, toggle, selectAll, clear, start, stop, retain } = useBulkSelect();

// the same menu as everywhere, in the admin flavour: every owner's library can be cleaned separately, the picker
// lists every playlist, and a music manager can edit what they don't own
function subjectOf(track: AllMediaRow) {
  return { kind: "track" as const, media: track, owned: track.owners.some((owner) => owner.userId === me.value?.id), canEdit: true };
}

function onChanged(change: MenuChange) {
  if (change.type === "edited" || change.type === "deleted") {
    void reset().then(() => retain(tracks.value.map((track) => track.id)));
  }
}

function toggleAll() {
  if (count.value >= tracks.value.length) clear();
  else selectAll(tracks.value.map((track) => track.id));
}

function onContextMenu(e: MouseEvent, track: AllMediaRow) {
  if (selecting.value) return;
  void openMenu(e, subjectOf(track), { owners: track.owners, pickerAdmin: true, onChanged });
}

function onBulkActions(e: MouseEvent) {
  const chosen = new Set(selectedIds.value);
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  void openBulkMenu({ x: rect.left, y: rect.top }, tracks.value.filter((track) => chosen.has(track.id)).map(subjectOf), { owners: [], pickerAdmin: true, onChanged });
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

.libtracks .tracks .owners {
  max-width: 160px;
  font-size: 0.75em;
  color: #666666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.libtracks .tracks .album {
  max-width: 200px;
  font-size: 0.85em;
  color: #666666;
}

.libtracks .tracks .filesize {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-discy);
  font-size: 0.7em;
}

.libtracks .tracks .duration {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-discy);
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

  .libtracks .tracks .album, .libtracks .tracks .owners, .libtracks .tracks .filesize {
    display: none;
  }

  .libtracks .tracks li {
    margin: 0 -1.2em;
    padding: 10px 1.2em;
  }
}
</style>
