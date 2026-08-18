<template>
  <Modal :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" :title="$t('playlist.picker.title')">
    <p v-if="playlists.length === 0" class="picker-empty">{{ $t('playlist.picker.empty') }}</p>
    <ul v-else class="plist">
      <li v-for="playlist in playlists" :key="playlist.id" @click="addTo(playlist.id)">
        <img :src="playlistImageUrl(playlist)" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
        <span>{{ playlist.title }}</span>
      </li>
    </ul>

    <button type="button" filled="hollow" @click="close">{{ $t('playlist.picker.cancel') }}</button>
  </Modal>
</template>

<script lang="ts" setup>
import noCover from '~/assets/no-cover.png';
import Modal from '~/components/Modal.vue';

interface PlaylistRow {
  id: string;
  title: string;
  image: string | null;
}

const props = defineProps<{ modelValue: boolean; mediaIds: string[]; admin?: boolean }>();
const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void }>();

const token = useCookie("nafynToken").value ?? "";
const playlists = ref<PlaylistRow[]>([]);

watch(() => props.modelValue, async (isOpen) => {
  if (!isOpen) return;
  const path = props.admin ? "/api/v1/playlist/all" : "/api/v1/playlist";
  playlists.value = await $fetch<PlaylistRow[]>(path, { headers: { Authorization: token } }).catch(() => []);
});

function playlistImageUrl(playlist: PlaylistRow): string {
  return playlist.image ? `/api/v1/playlist/${playlist.id}/image?token=${encodeURIComponent(token)}&v=${playlist.image}` : noCover;
}

async function addTo(playlistId: string) {
  try {
    await $fetch(`/api/v1/playlist/${playlistId}/tracks`, {
      method: "POST",
      headers: { Authorization: token },
      body: { mediaIds: props.mediaIds }
    });
    useToast().sendToast({ content: $t('playlist.picker.added'), tint: "green", icon: null, title: null });
    close();
  } catch (e) {
    const err = (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('playlist.picker.error');
    useToast().sendToast({ content: err, tint: "red", icon: null, title: null });
  }
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
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.picker-empty {
  color: #666666;
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

.plist img {
  width: 40px;
  height: 40px;
  border-radius: 5px;
  aspect-ratio: 1 / 1;
  background: #00000040;
}
</style>
