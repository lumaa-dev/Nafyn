<template>
  <Modal v-model="open" size="large" :title="$t('album.change.title')">
    <template #toolbar>
      <IconButton toolbar symbol="check" :label="moving ? $t('album.change.moving') : $t('album.change.move')" :disabled="!selected || selected.id === media?.albumId || moving" @click="move" />
    </template>
    <div class="change-album">
      <p v-if="media" class="intro">{{ $t('album.change.intro', { title: media.title, artist: media.artistName }) }}</p>

      <label class="search">
        <span class="label">{{ $t('album.change.search') }}</span>
        <input v-model="query" type="search" maxlength="200" autocomplete="off" spellcheck="false" :placeholder="$t('album.change.placeholder')">
      </label>

      <p v-if="searching" class="hint">{{ $t('album.change.searching') }}</p>
      <p v-else-if="searched && results.length === 0" class="hint">{{ $t('album.change.none') }}</p>

      <ul v-if="results.length > 0" class="results" role="listbox" :aria-label="$t('album.change.search')">
        <li v-for="album in results" :key="album.id">
          <button type="button" class="album" role="option" :class="{ selected: selected?.id === album.id }" :aria-selected="selected?.id === album.id" @click="selected = album">
            <CoverImage :src="coverArtUrl(album.coverArt ?? '', 250)" />
            <span class="col">
              <span class="name">{{ album.title }}</span>
              <span class="meta">{{ details(album) }}</span>
            </span>
            <span v-if="album.id === media?.albumId" class="current">{{ $t('album.change.current') }}</span>
          </button>
        </li>
      </ul>

      <p v-if="selected" class="warn">{{ $t('album.change.confirm', { title: media?.title ?? '', album: selected.title }) }}</p>
    </div>
  </Modal>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';
import Modal from '~/components/Modal.vue';
import { useAuthToken } from '~/composables/useAuthToken';

const props = defineProps<{ modelValue: boolean, media?: MediaRow | null }>();
const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void,
  (e: "moved", media: MediaRow): void
}>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value)
});

const { token } = useAuthToken();
const { sendToast, sendError } = useToast();

const query = ref("");
const results = ref<MediaInfo[]>([]);
const selected = ref<MediaInfo | null>(null);
const searching = ref(false);
const searched = ref(false);
const moving = ref(false);

// answers of an older search must not replace those of the one the person is waiting for
let searchSeq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

async function search(text: string) {
  const mine = ++searchSeq;
  if (!text.trim() || !token.value) {
    results.value = [];
    searching.value = false;
    searched.value = false;
    return;
  }

  searching.value = true;
  try {
    const found = await $fetch<{ albums: MediaInfo[] }>("/api/v1/search", {
      headers: { Authorization: token.value },
      query: { q: text.trim(), filter: "album", limit: 12 }
    });
    if (mine !== searchSeq) return;
    results.value = found.albums;
    searched.value = true;
  } catch (e) {
    if (mine !== searchSeq) return;
    results.value = [];
    sendError(null, e, $t('album.change.searchError'));
  } finally {
    if (mine === searchSeq) searching.value = false;
  }
}

watch(query, (value) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void search(value), 400);
});
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });

// every opening starts from the artist: usually the album being looked for is one of theirs
watch(() => props.modelValue, (isOpen) => {
  if (!isOpen) return;
  selected.value = null;
  results.value = [];
  searched.value = false;
  query.value = props.media?.artistName ?? "";
});

function details(album: MediaInfo): string {
  const artist = typeof album.artist === "string" ? album.artist : album.artist.name;
  const year = album.releaseDate ? new Date(album.releaseDate).getUTCFullYear() : null;
  const type = album.type === "ep" ? $t('edit.typeEp') : album.type === "album" ? $t('edit.typeAlbum') : null;
  return [artist, year, type].filter(Boolean).join(" · ");
}

async function move() {
  if (!props.media || !selected.value || !token.value) return;
  moving.value = true;
  try {
    const row = await $fetch<MediaRow>(`/api/v1/library/${props.media.id}/album`, {
      method: "PUT",
      headers: { Authorization: token.value },
      body: { albumId: selected.value.id }
    });
    sendToast({ title: null, content: $t('album.change.moved', { title: row.title, album: row.album ?? '' }), icon: null, tint: "green" });
    emit("moved", row);
    open.value = false;
  } catch (e) {
    sendError($t('album.change.title'), e, $t('album.change.error'));
  } finally {
    moving.value = false;
  }
}
</script>

<style>
.change-album {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: min(520px, 80vw);
}

.change-album .search {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.change-album .search input {
  width: 100%;
}

.change-album .hint,
.change-album .intro,
.change-album .warn {
  margin: 0;
  color: #ffffff;
}

.change-album .warn {
  font-weight: 700;
}

.change-album .results {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 40vh;
  overflow-y: auto;
  scrollbar-width: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.change-album .album {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: none;
  color: #ffffff;
  text-align: left;
  cursor: pointer;
}

.change-album .album:hover {
  background: #ffffff1a;
}

/* the border says "selected" without relying on the tint */
.change-album .album.selected {
  border-color: #ffffff;
  background: #ffffff26;
}

.change-album .album img {
  width: 48px;
  height: 48px;
  border-radius: 5px;
  flex-shrink: 0;
}

.change-album .album .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.change-album .album .name,
.change-album .album .meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.change-album .album .meta {
  font-size: 0.85em;
}

.change-album .album .current {
  font-size: 0.8em;
  font-weight: 700;
}

</style>
