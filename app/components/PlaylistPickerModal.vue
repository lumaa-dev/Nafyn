<template>
  <Modal :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" :title="$t('playlist.picker.title')">
    <!-- several playlists can be picked; the toolbar's check adds to all of them (DESIGN.md "Modals / Sheets") -->
    <template #toolbar>
      <IconButton toolbar symbol="check" :label="saving ? $t('playlist.picker.adding') : $t('playlist.picker.add', { count: selected.size })" :disabled="saving || selected.size === 0" @click="addToSelected" />
    </template>
    <p v-if="playlists.length === 0" class="picker-empty">{{ $t('playlist.picker.empty') }}</p>
    <ul v-else class="plist" role="listbox" aria-multiselectable="true" :aria-label="$t('playlist.picker.title')">
      <li
        v-for="playlist in playlists"
        :key="playlist.id"
        role="option"
        tabindex="0"
        :aria-selected="selected.has(playlist.id)"
        :class="{ selected: selected.has(playlist.id) }"
        @click="toggle(playlist.id)"
        @keydown.enter.prevent="toggle(playlist.id)"
        @keydown.space.prevent="toggle(playlist.id)"
      >
        <img :src="playlistImageUrl(playlist)" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
        <span class="name">{{ playlist.title }}</span>
        <!-- a tick, not only a colour, says which ones are picked -->
        <svg v-if="selected.has(playlist.id)" class="tick" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </li>
    </ul>
  </Modal>
</template>

<script lang="ts" setup>
import noCover from '~/assets/no-cover.png';
import Modal from '~/components/Modal.vue';
import IconButton from '~/components/IconButton.vue';
import { useAuthToken } from '~/composables/useAuthToken';

interface PlaylistRow {
  id: string;
  title: string;
  image: string | null;
}

const props = defineProps<{ modelValue: boolean; mediaIds: string[]; admin?: boolean }>();
const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void }>();

const token = useAuthToken().token.value ?? "";
const playlists = ref<PlaylistRow[]>([]);
const selected = ref(new Set<string>());
const saving = ref(false);

watch(() => props.modelValue, async (isOpen) => {
  if (!isOpen) return;
  selected.value = new Set();

  if (props.admin) {
    playlists.value = await $fetch<PlaylistRow[]>("/api/v1/playlist/all", { headers: { Authorization: token } }).catch((e) => {
      useToast().sendError(null, e, $t('playlist.picker.error'));
      return [];
    });
    return;
  }

  // paginated (server/utils/pagination.ts); a picker realistically never needs more than one generous page
  const result = await $fetch<{ items: PlaylistRow[] }>("/api/v1/playlist", { headers: { Authorization: token }, query: { limit: 200 } }).catch((e) => {
    useToast().sendError(null, e, $t('playlist.picker.error'));
    return { items: [] };
  });
  playlists.value = result.items;
});

function playlistImageUrl(playlist: PlaylistRow): string {
  return playlist.image ? `/api/v1/playlist/${playlist.id}/image?token=${encodeURIComponent(token)}&v=${playlist.image}` : noCover;
}

function toggle(playlistId: string) {
  const next = new Set(selected.value);
  if (next.has(playlistId)) next.delete(playlistId);
  else next.add(playlistId);
  selected.value = next;
}

// one call per playlist; the ones that failed stay picked so another try only sends those
async function addToSelected() {
  if (saving.value || selected.value.size === 0) return;
  saving.value = true;
  const failed = new Set<string>();
  let lastError: unknown = null;
  for (const playlistId of selected.value) {
    try {
      await $fetch(`/api/v1/playlist/${playlistId}/tracks`, {
        method: "POST",
        headers: { Authorization: token },
        body: { mediaIds: props.mediaIds }
      });
    } catch (e) {
      failed.add(playlistId);
      lastError = e;
    }
  }
  saving.value = false;

  const added = selected.value.size - failed.size;
  if (added > 0) useToast().sendToast({ content: $t('playlist.picker.addedMany', { count: added }), tint: "green", icon: null, title: null });
  if (failed.size > 0) {
    useToast().sendError(null, lastError, $t('playlist.picker.error'));
    selected.value = failed;
    return;
  }
  close();
}

function close() {
  emit("update:modelValue", false);
}
</script>

<style>
.plist {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plist::-webkit-scrollbar {
  display: none;
}

.picker-empty {
  color: #ffffff;
  font-size: 0.85em;
}

.plist li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px;
  border-radius: 8px;
  cursor: pointer;
}

.plist li:hover {
  background: #ffffff1a;
}

.plist li.selected {
  background: #ffffff26;
}

.plist li .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plist li .tick {
  flex-shrink: 0;
  color: #ffffff;
}

.plist img {
  width: 40px;
  height: 40px;
  border-radius: 5px;
  aspect-ratio: 1 / 1;
  background: #00000040;
}
</style>
