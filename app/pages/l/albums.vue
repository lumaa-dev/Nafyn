<template>
  <div class="libalbums bulk-page">
    <h1>{{ $t('library.albums.title') }}</h1>
    <div class="grid" v-if="albums.length > 0">
      <NuxtLink
        v-for="album in albums"
        :key="album.id"
        :to="`/l/a/${album.id}`"
        :class="{ 'selectable-card': selecting, selected: isSelected(album.id) }"
        :aria-pressed="selecting ? isSelected(album.id) : undefined"
        @click.capture="onCardClick($event, album)"
        @contextmenu.prevent="onContextMenu($event, album)"
      >
        <MediaBox :media="toMediaInfo(album)" />
        <span v-if="selecting" class="check" :class="{ on: isSelected(album.id) }" aria-hidden="true">{{ isSelected(album.id) ? '✓' : '' }}</span>
      </NuxtLink>
    </div>
    <p class="empty" v-else-if="!initialLoading">{{ $t('library.albums.empty') }}</p>
    <div ref="sentinel" class="scroll-sentinel" />
    <p class="loading-more" v-if="loadingMore">{{ $t('common.loadingMore') }}</p>

    <BulkBar :selecting="selecting" :count="count" :total="albums.length" @start="start" @stop="stop" @select-all="toggleAll" @actions="onBulkActions" />
  </div>
</template>

<script lang="ts" setup>
import MediaBox from '~/components/MediaBox.vue';
import type { AlbumRow } from '~~/server/core/library';
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';
import type { MenuChange } from '~/composables/useMediaMenu';
import { useAuthToken } from '~/composables/useAuthToken';

const { token } = useAuthToken();

const { items: albums, initialLoading, loadingMore, sentinel, loadMore, reset } = useInfiniteList<AlbumRow>((page, limit) => {
  return token.value
    ? $fetch("/api/v1/library/albums", { headers: { Authorization: token.value }, query: { page, limit } })
    : Promise.resolve({ items: [], page, limit, total: 0, hasMore: false });
});
await loadMore();

const { openMenu, openBulkMenu } = useMediaMenu();
const { selecting, selectedIds, count, isSelected, toggle, selectAll, clear, start, stop, retain } = useBulkSelect();

function onCardClick(e: MouseEvent, album: AlbumRow) {
  // in select mode a click picks the album instead of opening it
  if (!selecting.value) return;
  e.preventDefault();
  toggle(album.id);
}

function toggleAll() {
  if (count.value >= albums.value.length) clear();
  else selectAll(albums.value.map((album) => album.id));
}

function onChanged(change: MenuChange) {
  if (change.type === "deleted") {
    const gone = new Set(change.ids);
    albums.value = albums.value.filter((album) => !gone.has(album.id));
    retain(albums.value.map((album) => album.id));
  } else if (change.type === "edited") {
    // titles, covers and artists may have moved albums around: the cheap, correct answer is a fresh list
    void reset();
  }
}

function onContextMenu(e: MouseEvent, album: AlbumRow) {
  if (selecting.value) return;
  void openMenu(e, { kind: "album", album }, { onChanged });
}

function onBulkActions(e: MouseEvent) {
  const chosen = new Set(selectedIds.value);
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  void openBulkMenu({ x: rect.left, y: rect.top }, albums.value.filter((album) => chosen.has(album.id)).map((album) => ({ kind: "album" as const, album })), { onChanged });
}

function toMediaInfo(album: AlbumRow): MediaInfo {
  return {
    id: album.mbId,
    title: album.title ?? $t("common.unknownAlbum"),
    artist: album.artistName,
    album: null,
    type: null,
    // a track in the album may carry a user-uploaded cover, which wins over the Cover Art Archive URL
    coverArt: coverSrc(album),
    releaseDate: album.releaseDate ? new Date(album.releaseDate * 1000) : null,
    inLibrary: true,
    duration: album.duration,
    label: null,
    relations: {
      amId: undefined
    }
  };
}
</script>

<style>
.libalbums {
  width: 70vw;
  max-width: 1200px;
  margin: calc(15vh - 10px) auto;
}

.libalbums .empty {
  color: #666666;
}

.libalbums .scroll-sentinel {
  height: 1px;
}

.libalbums .loading-more {
  text-align: center;
  color: #666666;
  font-size: 0.8em;
  padding: 10px 0;
}

.libalbums .grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 20px;
}

.libalbums .grid a {
  position: relative;
  font-family: "Instrument-Serif";
  text-decoration: none;
}

.libalbums .grid a.selectable-card {
  cursor: pointer;
  border-radius: 8px;
}

.libalbums .grid a.selected {
  outline: 3px solid #ffffff;
  outline-offset: 3px;
}

/* the tick sits on the cover's corner; the outline above says the same without colour */
.libalbums .check {
  position: absolute;
  top: 8px;
  left: 8px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid #ffffff;
  background: rgba(0, 0, 0, 0.55);
  color: #000000;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-discy);
  font-size: 0.8em;
  font-weight: 700;
}

.libalbums .check.on {
  background: #ffffff;
}

@media screen and (max-width: 800px) {
  .libalbums {
    margin: calc(15vh - 10px) 1.2em;
  }
}
</style>
