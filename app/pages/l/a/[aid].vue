<template>
  <div class="libalbum bulk-page" v-if="detail">
    <div class="head">
      <CoverImage class="cover" :src="coverSrc(detail.album)" eager />
      <div class="meta">
        <h1>{{ detail.album.title }}</h1>
        <p class="artist">{{ detail.album.artistName }}</p>
        <div class="actions">
          <button type="button" filled :disabled="tracks.length === 0" @click="playAll">{{ $t('playlist.play') }}</button>
          <button type="button" filled :disabled="tracks.length === 0" @click="shuffleAll">{{ $t('playlist.shuffle') }}</button>
          <button type="button" filled="hollow" class="icon-only more" :title="$t('menu.more')" :aria-label="$t('menu.more')" @click="onAlbumMenu">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          </button>
        </div>
      </div>
    </div>

    <ol class="tracks" v-if="tracks.length > 0">
      <template v-for="group in discGroups" :key="group.number">
      <li v-if="discGroups.length > 1" class="disc" role="presentation">
        <h3>{{ group.label }}</h3>
      </li>
      <li v-for="track in group.tracks" :key="track.id" :class="{ playing: currentTrack?.id === track.id, 'selectable-row': selecting, selected: isSelected(track.id) }" @click="selecting ? toggle(track.id) : playFrom(track)" @contextmenu.prevent="onContextMenu($event, track)">
        <input v-if="selecting" type="checkbox" class="select-box" :checked="isSelected(track.id)" :aria-label="track.title" tabindex="-1" @click.stop="toggle(track.id)">
        <CoverImage :src="coverSrc(track)" />
        <span class="col">
          <span class="title">{{ track.title }}</span>
          <span class="artist">{{ track.artistName }}</span>
        </span>
        <span class="filesize" v-if="appearance.showFileSize">{{ track.fileSize != null ? formatBytes(track.fileSize) : '—' }}</span>
        <span class="duration" v-if="appearance.showDuration">{{ formatDuration(track.duration) }}</span>
        <button v-if="!selecting" type="button" class="ellipsis" @click.stop="onContextMenu($event, track)" :aria-label="$t('menu.more')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
      </li>
      </template>
    </ol>

    <BulkBar :selecting="selecting" :count="count" :total="tracks.length" @start="start" @stop="stop" @select-all="toggleAll" @actions="onBulkActions" />
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow, AlbumRow } from '~~/server/core/library';
import type { MenuChange } from '~/composables/useMediaMenu';
import { useAppearanceSettings } from '~/composables/useAppearanceSettings';
import { useAuthToken } from '~/composables/useAuthToken';

const aid = useRoute().params.aid as string;
const { token } = useAuthToken();
const appearance = useAppearanceSettings();

interface LibraryAlbumDetail {
  album: AlbumRow;
  tracks: MediaRow[];
}

const { data: detail, error } = await useAsyncData<LibraryAlbumDetail>(`library-album-${aid}`, () => {
  return token.value
    ? $fetch(`/api/v1/library/album/${aid}`, { headers: { Authorization: token.value } })
    : Promise.reject(new Error("Not authenticated"));
});
useLoadErrorToast(error);

const tracks = computed<MediaRow[]>(() => detail.value?.tracks ?? []);

// the tracks are already ordered disc by disc; a row with no disc is on disc 1. A disc header is only drawn
// when the owned tracks span more than one disc, and an unnamed disc reads "Disc N".
const discGroups = computed(() => {
  const groups = new Map<number, { number: number, title: string | null, tracks: MediaRow[] }>();
  for (const track of tracks.value) {
    const number = track.discNumber ?? 1;
    const group = groups.get(number) ?? { number, title: null, tracks: [] };
    groups.set(number, group);
    group.title ??= track.discTitle;
    group.tracks.push(track);
  }
  return [...groups.values()].map((group) => ({ ...group, label: group.title ?? $t('album.disc', { number: group.number }) }));
});

const { currentTrack, play } = useUnity();

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

const { openMenu, openBulkMenu } = useMediaMenu();
const { selecting, selectedIds, count, isSelected, toggle, selectAll, clear, start, stop, retain } = useBulkSelect();

function onChanged(change: MenuChange) {
  if (change.type === "deleted" && change.ids.includes(aid)) {
    // the whole album went
    void navigateTo("/l/albums");
  } else if (change.type !== "pinned") {
    void refreshNuxtData(`library-album-${aid}`).then(() => {
      retain(tracks.value.map((track) => track.id));
      if (tracks.value.length === 0) void navigateTo("/l/albums");
    });
  }
}

function onContextMenu(e: MouseEvent, track: MediaRow) {
  if (selecting.value) return;
  void openMenu(e, { kind: "track", media: track }, { onChanged });
}

function onAlbumMenu(e: MouseEvent) {
  if (!detail.value) return;
  void openMenu(e, { kind: "album", album: detail.value.album }, { hideDetails: true, onChanged });
}

function toggleAll() {
  if (count.value >= tracks.value.length) clear();
  else selectAll(tracks.value.map((track) => track.id));
}

function onBulkActions(e: MouseEvent) {
  const chosen = new Set(selectedIds.value);
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  void openBulkMenu({ x: rect.left, y: rect.top }, tracks.value.filter((track) => chosen.has(track.id)).map((media) => ({ kind: "track" as const, media })), { onChanged });
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

.libalbum .tracks li.disc,
.libalbum .tracks li.disc:not(:last-child) {
  padding: 24px 0 8px;
  border-bottom: 1px solid #ffffff;
}

.libalbum .tracks li.disc h3 {
  margin: 0;
  font-size: 1em;
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

.libalbum .tracks .filesize {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-discy);
  font-size: 0.7em;
}

.libalbum .tracks .duration {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-discy);
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

  .libalbum .tracks .filesize {
    display: none;
  }
}
</style>
